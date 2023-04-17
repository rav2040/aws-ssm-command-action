import { getBooleanInput, getInput, setOutput, setFailed, info, error } from "@actions/core";
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

        const exitCode = await printCommandOutput(instanceId, commandId);

        if (exitCode !== undefined) {
            setOutput("exit-code", exitCode);
        }
    } catch (err) {
        if (err instanceof Error) setFailed(err);
    }
}

async function printCommandOutput(instanceId: string, commandId: string): Promise<number | undefined> {
    await sleep(5);

    const response = await ssm.send(new GetCommandInvocationCommand({
        InstanceId: instanceId,
        CommandId: commandId,
    }));

    if (["Success", "Failed", "Cancelled", "TimedOut"].includes(response.Status ?? "")) {
        return response.ResponseCode ?? -1;
    }

    if (response.StandardOutputContent) {
        info(response.StandardOutputContent);
    }

    if (response.StandardErrorContent) {
        error(response.StandardErrorContent);
    }

    return printCommandOutput(instanceId, commandId);
}

function sleep(n: number) {
    return new Promise<void>((r) => setTimeout(r, n * 1000));
}

main();
