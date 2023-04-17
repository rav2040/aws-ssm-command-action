import { getBooleanInput, getInput, setOutput, setFailed, info, debug } from "@actions/core";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import styles from "ansi-styles";

const ssm = new SSMClient({});

async function main() {
    try {
        const command = getInput("command", { required: true });
        const instanceId = getInput("instance-id") || process.env.SSM_COMMAND_INSTANCE_ID;
        const powershell = getBooleanInput("powershell");

        if (instanceId === undefined) {
            setFailed(Error("An instance ID must be provided."));
            return;
        }

        const sendCommandResponse = await ssm.send(new SendCommandCommand({
            DocumentName: powershell ? "AWS-RunPowerShellScript" : "AWS-RunShellScript",
            InstanceIds: [instanceId],
            Parameters: { commands: [command] },
        }));

        debug(`SendCommandOutput: ${JSON.stringify(sendCommandResponse, null, 2)}`);

        const commandId = sendCommandResponse.Command?.CommandId;

        if (sendCommandResponse.$metadata.httpStatusCode !== 200 || !commandId) return;

        info("Waiting for remote command invocation to complete...");

        const exitCode = await waitSendCommand(instanceId, commandId);

        if (exitCode !== undefined) {
            setOutput("exit-code", exitCode);
        }

        info(`Remote command invocation has completed with exit code: ${exitCode}`);
    } catch (err) {
        if (err instanceof Error) setFailed(err);
    }
}

async function waitSendCommand(instanceId: string, commandId: string): Promise<number> {
    await sleep(5);

    const response = await ssm.send(new GetCommandInvocationCommand({
        InstanceId: instanceId,
        CommandId: commandId,
    }));

    debug(`GetCommandInvocationOutput: ${JSON.stringify(response, null, 2)}`);

    if (["Failed", "Cancelled", "TimedOut"].includes(response.Status ?? "")) {
        info(`Remote command invocation ended unexpectedly with status: "${response.Status}". Standard error content is printed below.`);
        info(styles.red.open + styles.bold.open + "----- BEGIN STDERR CONTENT -----");
        (response.StandardErrorContent ?? "").trim().split(/\r?\n/).forEach((line) => {
            return info(styles.red.open + styles.bold.open + line);
        });
        info(styles.red.open + styles.bold.open + "----- END STDERR CONTENT -----");

        return response.ResponseCode ?? -1;
    }

    if (response.Status === "Success") {
        info("Remote command invocation completed successfully. Standard output content is printed below.");
        info(styles.cyan.open + "----- BEGIN STDOUT CONTENT -----");
        (response.StandardOutputContent ?? "").trim().split(/\r?\n/).forEach((line) => {
            return info(styles.cyan.open + line);
        });
        info(styles.cyan.open + "----- END STDOUT CONTENT -----");

        return response.ResponseCode ?? -1;
    }

    info("Still waiting...");

    return waitSendCommand(instanceId, commandId);
}

function sleep(n: number) {
    return new Promise<void>((r) => setTimeout(r, n * 1000));
}

main();
