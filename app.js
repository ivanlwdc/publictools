let targetGatewayName = null;
let targetGatewayUid = null;
let targetGatewayIp = "";
let smsUid = null;
let payloadScript = "";

const logEl = document.getElementById('logs');
const btnEl = document.getElementById('install-btn');
const gatewayNameEl = document.getElementById('gateway-name');

function logInfo(msg) {
    if (logEl.textContent === "Waiting for initialization...") {
        logEl.textContent = "";
    }
    console.log(msg);
    logEl.textContent += `[INFO] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

function logError(msg) {
    if (logEl.textContent === "Waiting for initialization...") {
        logEl.textContent = "";
    }
    console.error(msg);
    logEl.textContent += `[ERROR] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

logInfo("app.js evaluated successfully.");


let cbCounter = 0;
function sendToSmx(functionName, parameters) {
    return new Promise((resolve, reject) => {
        if (typeof window.smxProxy === 'undefined') {
            reject(new Error("smxProxy missing. This page must be run inside Check Point SmartConsole."));
            return;
        }
        const cbName = `smxCb_${++cbCounter}`;
        window[cbName] = (res) => {
            resolve(res);
            delete window[cbName];
        };
        try {
            window.smxProxy.sendRequest(functionName, parameters, cbName);
        } catch (e) {
            reject(e);
        }
    });
}

// Ensure global callback is accessible to smx
window.onContext = async function(obj) {
    try {
        if (!obj || !obj.event || !obj.event.objects || obj.event.objects.length === 0) {
            throw new Error("No gateway selected in context.");
        }
        
        const gw = obj.event.objects[0];
        targetGatewayName = gw.name.trim();
        targetGatewayUid = gw.uid;
        
        // If explicitly set to dynamic, clear the IP to force DAIP logic
        let isDynamic = gw['dynamic-ip'] === true || gw['dynamic-ip'] === 'true';
        let pIP = gw['ipv4-address'] || gw.ipv4Address || "";
        targetGatewayIp = (!isDynamic && pIP && !pIP.startsWith("0.")) ? pIP : "";
        
        gatewayNameEl.textContent = `${targetGatewayName}`;
        gatewayNameEl.classList.remove('loading');
        
        logInfo(`Context loaded. Target Gateway: ${targetGatewayName}`);
        logInfo("Fetching dynamic objects script payload...");
        
        try {
            // Because index.html and dynamic_objects_script.txt are in the same directory requested by python webserver
            const res = await fetch("dynamic_objects_script.txt?t=" + new Date().getTime());
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            payloadScript = await res.text();
            logInfo(`Successfully loaded payload script (${payloadScript.length} bytes).`);
        } catch (err) {
            throw new Error(`Failed to load dynamic_objects_script.txt: ${err.message}`);
        }

        logInfo("Discovering Management Server (SMS) UID...");
        const gatewaysRes = await sendToSmx("run-readonly-command", {
            "command": "show-gateways-and-servers",
            "parameters": {"details-level": "full", "limit": 500}
        });

        // Navigate into 'objects' array from response recursively to never miss it
        function findObjectsArr(obj) {
            if (!obj) return null;
            if (obj.objects && Array.isArray(obj.objects)) return obj.objects;
            for (let k of Object.keys(obj)) {
                if (typeof obj[k] === 'object') {
                    let res = findObjectsArr(obj[k]);
                    if (res) return res;
                }
            }
            return null;
        }
        let gwObjects = findObjectsArr(gatewaysRes);

        if (gwObjects && gwObjects.length > 0) {
            for (let gwObj of gwObjects) {
                // If it's a known static proxy gateway, extract IP
                if (gwObj.uid === targetGatewayUid || gwObj.name === targetGatewayName) {
                    let gwIsDynamic = gwObj['dynamic-ip'] === true || gwObj['dynamic-ip'] === 'true';
                    if (gwIsDynamic) {
                        targetGatewayIp = ""; // Force DAIP resolution
                    } else if (!targetGatewayIp && gwObj['ipv4-address']) {
                        let ip = gwObj['ipv4-address'];
                        if (ip && !ip.startsWith("0.")) {
                            targetGatewayIp = ip;
                        }
                    }
                }
                
                let type = gwObj.type;
                if (type === "management-server" || type === "domain-management-server" || type === "CpmiManagementServer" || type === "CpmiDomainManagementServer") {
                    smsUid = gwObj.uid;
                    logInfo(`Found SMS: ${gwObj.name} (${smsUid})`);
                } else if (!smsUid && (type === "checkpoint-host" || type === "CpmiHostCkp")) {
                    smsUid = gwObj.uid;
                    logInfo(`Found SMS (Check Point Host): ${gwObj.name} (${smsUid})`);
                }
            }
        }
        
        if (targetGatewayIp) {
            logInfo(`Found static Gateway IP: ${targetGatewayIp}`);
        } else {
             logInfo("No static IP found. Will attempt DAIP lookup strictly.");
        }
        
        if (!smsUid) {
            if (gwObjects && gwObjects.length > 0) {
                let serverTypes = gwObjects.map(g => `${g.name} (${g.type})`).join(', ');
                logInfo(`Warning: SMS not automatically detected by type. I see these devices: ${serverTypes}`);
            } else {
                logInfo("Warning: No devices were found in the API response. Raw response: " + JSON.stringify(gatewaysRes));
            }
            logInfo("Falling back to hardcoded target: SMS1-015-DCVDF1 (this may cause issues if deployed elsewhere).");
            smsUid = "SMS1-015-DCVDF1"; 
        }

        // Enable install button
        btnEl.disabled = false;
        
    } catch (e) {
        logError(e.message || e);
        gatewayNameEl.textContent = "Error: Cannot determine gateway.";
    }
}

function findTaskIds(obj, ids = new Set()) {
    if (!obj) return ids;
    if (typeof obj === 'object') {
        if (obj["task-id"]) ids.add(obj["task-id"]);
        for (const k in obj) findTaskIds(obj[k], ids);
    }
    return ids;
}

btnEl.addEventListener('click', async () => {
    btnEl.disabled = true;
    try {
        logInfo("Generating cprid_util robust wrapper script...");
        const safeName = targetGatewayName.replace(/[^a-zA-Z0-9_-]/g, '_');
        
        // This is a robust bash script that securely deploys the dynamic_objects_script.txt to the Spark Gateway
        // We use safeName exclusively for generating clean temporary files without spaces.
        // We use targetGatewayName explicitly for Check Point SIC and DB lookups.
        const finalScript = `#!/bin/bash
source /etc/profile.d/CP.sh
TARGET_GW="${targetGatewayName}"
SAFE_GW="${safeName}"
STATIC_IP="${targetGatewayIp}"

cat << 'EOF_PAYLOAD' > "/var/log/tmp/payload_\${SAFE_GW}.sh"
${payloadScript}
EOF_PAYLOAD

if [ -n "\$STATIC_IP" ]; then
    DAIP_IP="\$STATIC_IP"
    echo "Using standard static IP: \$DAIP_IP"
else
    echo "Fetching DAIP for \$TARGET_GW..."
    DAIP_RAW=$(rs_db_tool -operation fetch -name "\$TARGET_GW" 2>&1)
    echo "Raw DAIP output: \$DAIP_RAW"

    DAIP_IP=$(echo "\$DAIP_RAW" | grep -E '^\\s*IP\\s*=' | head -n 1 | cut -d"=" -f2 | tr -d " ")

    if [ -z "\$DAIP_IP" ]; then
        echo "Could not resolve DAIP, defaulting to name."
        DAIP_IP="\$TARGET_GW"
    else
        echo "Resolved DAIP: \$DAIP_IP"
    fi
fi

echo "Pushing script to gateway via SIC..."
$CPDIR/bin/cprid_util putfile -server "\$DAIP_IP" -local_file "/var/log/tmp/payload_\${SAFE_GW}.sh" -remote_file "/tmp/payload_\${SAFE_GW}.sh" 2>&1

echo "Sending execution command to gateway via SIC..."
$CPDIR/bin/cprid_util -server "\$DAIP_IP" -verbose rexec -rcmd /bin/sh -c "chmod +x '/tmp/payload_\${SAFE_GW}.sh' && '/tmp/payload_\${SAFE_GW}.sh' > '/tmp/cprid_out_\${SAFE_GW}.txt' 2>&1" 2>&1

echo "Retrieving output file..."
$CPDIR/bin/cprid_util getfile -server "\$DAIP_IP" -local_file "/var/log/tmp/cprid_out_\${SAFE_GW}.txt" -remote_file "/tmp/cprid_out_\${SAFE_GW}.txt" 2>&1

echo "--- REMOTE OUTPUT ---"
cat "/var/log/tmp/cprid_out_\${SAFE_GW}.txt"

echo "Cleanup..."
rm -f "/var/log/tmp/payload_\${SAFE_GW}.sh" "/var/log/tmp/cprid_out_\${SAFE_GW}.txt"
$CPDIR/bin/cprid_util -server "\$DAIP_IP" -verbose rexec -rcmd /bin/sh -c "rm -f '/tmp/payload_\${SAFE_GW}.sh' '/tmp/cprid_out_\${SAFE_GW}.txt'" 2>&1
`;
        
        const b64Script = btoa(unescape(encodeURIComponent(finalScript)));
        
        // Request commit takes an array of Check Point Mgmt CLI strings
        const cliCommand = `run-script script-name "Install DynObjs to ${targetGatewayName}" script-base64 "${b64Script}" targets.1 "${smsUid}" --format json --sync false`;
        
        logInfo("Dispatching execute command to Management API via smxProxy...");
        const commitRes = await sendToSmx("request-commit", { commands: [cliCommand] });
        
        const tids = Array.from(findTaskIds(commitRes));
        if (tids.length === 0) {
            logError("No task-id returned from request-commit. Please check user permissions.");
            logInfo(JSON.stringify(commitRes));
            btnEl.disabled = false;
            return;
        }

        const taskId = tids[0];
        logInfo("Task successfully submitted. Task ID: " + taskId);
        
        // Poll for completion
        while (true) {
            await new Promise(r => setTimeout(r, 4000));
            logInfo("Polling task status...");
            
            const taskRes = await sendToSmx("run-readonly-command", {
                "command": "show-task",
                "parameters": {"task-id": taskId, "details-level": "full"}
            });
            
            let status = "unknown";
            let taskObj = null;
            
            // Navigate into 'tasks' array from response recursively to never miss it
            function findTasksArr(obj) {
                if (!obj) return null;
                if (obj.tasks && Array.isArray(obj.tasks)) return obj.tasks;
                for (let k of Object.keys(obj)) {
                    if (typeof obj[k] === 'object') {
                        let res = findTasksArr(obj[k]);
                        if (res) return res;
                    }
                }
                return null;
            }
            let tasksArr = findTasksArr(taskRes);

            if (tasksArr && tasksArr.length > 0) {
                taskObj = tasksArr[0];
                status = taskObj.status || status;
            } else {
                logInfo("Could not parse tasks array. Raw API Response: " + JSON.stringify(taskRes));
            }
            
            if (status === "succeeded" || status === "failed" || status === "partially succeeded" || status === "succeed") {
                logInfo(`Task finished with status: ${status}`);
                
                let details = taskObj ? (taskObj["task-details"] || []) : [];
                let outputStr = "No detail returns.";
                
                if (details.length > 0) {
                    let b64Out = details[0].responseMessage || details[0]["response-message"];
                    if (b64Out) {
                        try {
                            outputStr = decodeURIComponent(escape(atob(b64Out)));
                        } catch(e) { 
                            outputStr = b64Out; 
                        }
                    } else {
                        outputStr = JSON.stringify(taskObj, null, 2);
                    }
                }
                logInfo("--- TASK OUTPUT ---");
                logInfo(outputStr);
                logInfo("--- END OUTPUT ---");
                break;
            }
        }
        
    } catch (e) {
        logError(e.message || e);
    } finally {
        btnEl.disabled = false;
    }
});

window.initPlugin = function() {
    logInfo("initPlugin() invoked by onload handler.");
    try {
        // For local testing in a normal browser (Mock logic so user can see UI locally without SmartConsole):
        if (typeof window.smxProxy === 'undefined') {
            logInfo("window.smxProxy is undefined. Falling back to mock logic.");
            setTimeout(() => {
                logError("Not detected inside SmartConsole. Providing mock context for UI testing only.");
                window.onContext({
                    event: {
                        objects: [{ name: "MOCK-FW1-015", uid: "00000000-0000-0000-0000-000000000000", type: "simple-gateway" }]
                    }
                });
                
                // Mock sendToSmx so button clicks don't crash but show fake success.
                window.smxProxy = {
                    sendRequest: (cmd, params, cbName) => {
                        logInfo(`Mock request intercepted: ${cmd}`);
                        if(cmd === 'run-readonly-command' && params.command === 'show-gateways-and-servers') {
                            window[cbName]({ objects: [{ name: "MOCK-SMS", uid: "111", type: "management-server" }] });
                        } else if(cmd === 'request-commit') {
                            window[cbName]({ tasks: [{ "task-id": "mock-task-1234" }] });
                        } else if(cmd === 'run-readonly-command' && params.command === 'show-task') {
                            window[cbName]({ tasks: [{ status: "succeeded", "task-details": [{ responseMessage: btoa("Mock success output") }] }] });
                        }
                    }
                };
            }, 1000);
        } else {
            logInfo("window.smxProxy detected. Sending 'get-context' request...");
            // Actually request the context from SmartConsole
            window.smxProxy.sendRequest("get-context", null, "onContext");
            logInfo("Request sent. Waiting for 'onContext' callback.");
        }
    } catch (e) {
        logError("Exception in initPlugin: " + e.message);
    }
};
