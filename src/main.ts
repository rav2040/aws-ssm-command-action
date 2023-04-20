import type { GetCommandInvocationCommandOutput } from "@aws-sdk/client-ssm";

import { getBooleanInput, getInput, setOutput, setFailed, info, debug } from "@actions/core";
import {
    SSMClient,
    DescribeInstanceInformationCommand,
    SendCommandCommand,
    GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import styles from "ansi-styles";

const ssm = new SSMClient({});
const cloudWatchLogs = new CloudWatchLogsClient({});

async function main() {
    try {
        const command = getInput("command", { required: true });
        const instanceId = getInput("instance-id") || process.env.SSM_COMMAND_INSTANCE_ID;
        const powershell = getBooleanInput("powershell");
        const waitForAgent = getBooleanInput("wait-for-agent");

        if (instanceId === undefined) {
            setFailed(Error("An instance ID must be provided."));
            return;
        }

        if (waitForAgent) {
            await waitForSSMAgent(instanceId);
        }

        const ssmDocumentName = powershell ? "AWS-RunPowerShellScript" : "AWS-RunShellScript";

        const sendCommandResponse = await ssm.send(new SendCommandCommand({
            DocumentName: ssmDocumentName,
            InstanceIds: [instanceId],
            Parameters: { commands: [command, "echo '==========END OF OUTPUT=========='"] },
            CloudWatchOutputConfig: { CloudWatchOutputEnabled: true },
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

async function waitForSSMAgent(instanceId: string, i = 0): Promise<void> {
    const response = await ssm.send(new DescribeInstanceInformationCommand({
        Filters: [
            {
                Key: "InstanceIds",
                Values: [instanceId],
            },
        ],
    }));

    debug(`DescribeInstanceInformationOutput: ${JSON.stringify(response, null, 2)}`);

    if (response.InstanceInformationList?.[0]?.PingStatus !== "Online") {
        info(i === 0 ? "Waiting for SSM agent to come online..." : "Still waiting...");
        await sleep(5);
        return waitForSSMAgent(instanceId, i + 1);
    }

    info("SSM agent is online.")
}

async function waitSendCommand(instanceId: string, commandId: string): Promise<number> {
    await sleep(5);

    const response = await ssm.send(new GetCommandInvocationCommand({
        InstanceId: instanceId,
        CommandId: commandId,
    }));

    debug(`GetCommandInvocationOutput: ${JSON.stringify(response, null, 2)}`);

    if (["Success", "Failed", "Cancelled", "TimedOut"].includes(response.Status ?? "")) {
        info(`Remote command invocation completed with status: "${response.Status}". Fetching output...`);

        if (response.StandardOutputContent) {
            const messages = await getLogMessages(response, "stdout");
            printStdout(messages.join(""));
        }

        if (response.StandardErrorContent) {
            const messages = await getLogMessages(response, "stderr");
            printStderr(messages.join(""));
        }

        if (!response.StandardOutputContent && !response.StandardErrorContent) {
            info(styles.gray.open + styles.bold.open + "No output found.");
        }

        return response.ResponseCode ?? -1;
    }

    info("Still waiting...");

    return waitSendCommand(instanceId, commandId);
}

function printStdout(content: string) {
    info(styles.cyan.open + "----- BEGIN STDOUT CONTENT -----");
    content.trim().split(/\r?\n/).forEach((line) => {
        return info(styles.cyan.open + line);
    });
    info(styles.cyan.open + "----- END STDOUT CONTENT -----");
}

function printStderr(content: string) {
    info(styles.red.open + styles.bold.open + "----- BEGIN STDERR CONTENT -----");
    content.trim().split(/\r?\n/).forEach((line) => {
        return info(styles.red.open + styles.bold.open + line);
    });
    info(styles.red.open + styles.bold.open + "----- END STDERR CONTENT -----");
}

async function getLogMessages(commandInvocationOutput: GetCommandInvocationCommandOutput, stream: "stdout" | "stderr", token?: string): Promise<string[]> {
    const {
        DocumentName: documentName,
        CommandId: commandId,
        InstanceId: instanceId,
        PluginName: pluginName,
    } = commandInvocationOutput;

    const response = await cloudWatchLogs.send(new GetLogEventsCommand({
        logGroupName: "/aws/ssm/" + documentName,
        logStreamName: `${commandId}/${instanceId}/${pluginName?.replace(":", "-")}/${stream}`,
        nextToken: token,
    }));

    debug(`GetLogEventsCommandOutput: ${JSON.stringify(response, null, 2)}`);

    const result = (response.events ?? []).map((e) => e.message).filter((m): m is string => m !== undefined);

    return response.nextForwardToken
        ? result.concat(await getLogMessages(commandInvocationOutput, stream, response.nextForwardToken))
        : result;
}

function sleep(n: number) {
    return new Promise<void>((r) => setTimeout(r, n * 1000));
}

main();
