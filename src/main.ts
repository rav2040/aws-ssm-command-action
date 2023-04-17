import { getBooleanInput, getInput, setOutput, setFailed, info } from "@actions/core";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";

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

    if (["Failed", "Cancelled", "TimedOut"].includes(response.Status ?? "")) {
        throw Error(`Remote command invocation ended unexpectedly with status: "${response.Status}"`);
    }

    if (response.Status === "Success") {
        if (response.ResponseCode === 0) {
            info("Remote command invocation completed successfully. Standard output content is printed below.\n\n");
            info(response.StandardOutputContent ?? "");
        }

        if (response.ResponseCode !== 0) {
            info(`Remote command invocation completed with a non-zero exit code (${response.ResponseCode}). Standard error content is printed below.\n\n`);
            info(response.StandardErrorContent ?? "");
        }

        return response.ResponseCode ?? -1;
    }

    info("Still waiting...");

    return waitSendCommand(instanceId, commandId);
}

function sleep(n: number) {
    return new Promise<void>((r) => setTimeout(r, n * 1000));
}

main();
