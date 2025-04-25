import { VSCodeBadge, VSCodeProgressRing } from "@vscode/webview-ui-toolkit/react"
import deepEqual from "fast-deep-equal"
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useEvent, useSize } from "react-use"
import styled from "styled-components"
import {
	ClineApiReqInfo,
	ClineAskQuestion,
	ClineAskUseMcpServer,
	ClineMessage,
	ClinePlanModeResponse,
	ClineSayTool,
	COMPLETION_RESULT_CHANGES_FLAG,
	ExtensionMessage,
} from "@shared/ExtensionMessage"
import { COMMAND_OUTPUT_STRING, COMMAND_REQ_APP_STRING } from "@shared/combineCommandSequences"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { findMatchingResourceOrTemplate, getMcpServerDisplayName } from "@/utils/mcp"
import { vscode } from "@/utils/vscode"
import { CheckmarkControl } from "@/components/common/CheckmarkControl"
import { CheckpointControls } from "../common/CheckpointControls" // Removed CheckpointOverlay as it's not used directly here
import CodeAccordian, { cleanPathPrefix } from "../common/CodeAccordian"
import CodeBlock, { CODE_BLOCK_BG_COLOR } from "@/components/common/CodeBlock"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import Thumbnails from "@/components/common/Thumbnails"
import McpToolRow from "@/components/mcp/configuration/tabs/installed/server-row/McpToolRow"
import McpResponseDisplay from "@/components/mcp/chat-display/McpResponseDisplay"
import CreditLimitError from "@/components/chat/CreditLimitError"
import { OptionsButtons } from "@/components/chat/OptionsButtons"
import { highlightMentions } from "./TaskHeader"
import SuccessButton from "@/components/common/SuccessButton"
import TaskFeedbackButtons from "@/components/chat/TaskFeedbackButtons"
import NewTaskPreview from "./NewTaskPreview"
import McpResourceRow from "@/components/mcp/configuration/tabs/installed/server-row/McpResourceRow"

const ChatRowContainer = styled.div`
	padding: 10px 6px 10px 15px;
	position: relative;

	&:hover ${CheckpointControls} {
		opacity: 1;
	}
`

interface ChatRowProps {
	message: ClineMessage
	isExpanded: boolean
	onToggleExpand: () => void
	lastModifiedMessage?: ClineMessage
	isLast: boolean
	onHeightChange: (isTaller: boolean) => void
	inputValue?: string
}

interface ChatRowContentProps extends Omit<ChatRowProps, "onHeightChange"> {}

// Moved outside as it doesn't depend on component state/props
const getIconSpan = (iconName: string, color: string) => (
	<div
		style={{
			width: 16,
			height: 16,
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
		}}>
		<span
			className={`codicon codicon-${iconName}`}
			style={{
				color,
				fontSize: 16,
				marginBottom: "-1.5px",
			}}></span>
	</div>
)

export const ProgressIndicator = () => (
	<div
		style={{
			width: "16px",
			height: "16px",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
		}}>
		<div style={{ transform: "scale(0.55)", transformOrigin: "center" }}>
			<VSCodeProgressRing />
		</div>
	</div>
)

const Markdown = memo(({ markdown }: { markdown?: string }) => {
	return (
		<div
			style={{
				wordBreak: "break-word",
				overflowWrap: "anywhere",
				marginBottom: -15,
				marginTop: -15,
			}}>
			<MarkdownBlock markdown={markdown} />
		</div>
	)
})

const ChatRow = memo((props: ChatRowProps) => {
	const { isLast, onHeightChange, message } = props // Removed unused vars
	const prevHeightRef = useRef(0)

	const [chatrow, { height }] = useSize(
		<ChatRowContainer>
			<ChatRowContent {...props} />
		</ChatRowContainer>,
	)

	useEffect(() => {
		const isInitialRender = prevHeightRef.current === 0
		if (isLast && height !== 0 && height !== Infinity && height !== prevHeightRef.current) {
			if (!isInitialRender) {
				onHeightChange(height > prevHeightRef.current)
			}
			prevHeightRef.current = height
		}
	}, [height, isLast, onHeightChange, message]) // Added message to dependencies as it affects content height

	return chatrow
}, deepEqual)

export default ChatRow

export const ChatRowContent = ({
	message,
	isExpanded,
	onToggleExpand,
	lastModifiedMessage,
	isLast,
	inputValue,
}: ChatRowContentProps) => {
	const { mcpServers, mcpMarketplaceCatalog } = useExtensionState()
	const [seeNewChangesDisabled, setSeeNewChangesDisabled] = useState(false)
	const [startTime, setStartTime] = useState<number | null>(null)
	const [elapsedTime, setElapsedTime] = useState<number | null>(null)
	const [finalElapsedTime, setFinalElapsedTime] = useState<number | null>(null) // State for final duration
	const intervalRef = useRef<NodeJS.Timeout | null>(null)

	const [cost, apiReqCancelReason, apiReqStreamingFailedMessage] = useMemo(() => {
		if (message.text != null && message.say === "api_req_started") {
			try {
				const info: ClineApiReqInfo = JSON.parse(message.text)
				return [info.cost, info.cancelReason, info.streamingFailedMessage]
			} catch (e) {
				console.error("Failed to parse api_req_started text:", message.text, e)
			}
		}
		return [undefined, undefined, undefined]
	}, [message.text, message.say])

	const apiRequestFailedMessage =
		isLast && lastModifiedMessage?.ask === "api_req_failed" ? lastModifiedMessage?.text : undefined

	const isCommandExecuting =
		isLast &&
		(lastModifiedMessage?.ask === "command" || lastModifiedMessage?.say === "command") &&
		lastModifiedMessage?.text?.includes(COMMAND_OUTPUT_STRING)

	const isMcpServerResponding = isLast && lastModifiedMessage?.say === "mcp_server_request_started"

	const type = message.type === "ask" ? message.ask : message.say

	const normalColor = "var(--vscode-foreground)"
	const errorColor = "var(--vscode-errorForeground)"
	const successColor = "var(--vscode-charts-green)"
	const cancelledColor = "var(--vscode-descriptionForeground)"

	const handleMessage = useCallback((event: MessageEvent) => {
		const msg: ExtensionMessage = event.data // Renamed to avoid conflict
		switch (msg.type) {
			case "relinquishControl": {
				setSeeNewChangesDisabled(false)
				break
			}
		}
	}, [])

	useEvent("message", handleMessage)

	// Effect to manage the timer interval
	useEffect(() => {
		if (startTime !== null) {
			if (intervalRef.current) {
				clearInterval(intervalRef.current)
			}
			intervalRef.current = setInterval(() => {
				setElapsedTime(Date.now() - startTime)
			}, 100)
		} else {
			if (intervalRef.current) {
				clearInterval(intervalRef.current)
				intervalRef.current = null
			}
			// Don't reset elapsedTime here, let finalElapsedTime hold the value
			// setElapsedTime(null)
		}
		return () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current)
				intervalRef.current = null
			}
		}
	}, [startTime])

	const [icon, title]: [React.ReactNode, React.ReactNode] = useMemo(() => {
		switch (type) {
			case "error":
				return [getIconSpan("error", errorColor), <span style={{ color: errorColor, fontWeight: "bold" }}>Error</span>]
			case "mistake_limit_reached":
				return [
					getIconSpan("error", errorColor),
					<span style={{ color: errorColor, fontWeight: "bold" }}>Cline is having trouble...</span>,
				]
			case "auto_approval_max_req_reached":
				return [
					getIconSpan("warning", errorColor),
					<span style={{ color: errorColor, fontWeight: "bold" }}>Maximum Requests Reached</span>,
				]
			case "command":
				return [
					isCommandExecuting ? <ProgressIndicator /> : getIconSpan("terminal", normalColor),
					<span style={{ color: normalColor, fontWeight: "bold" }}>Clare wants to execute this command:</span>,
				]
			case "use_mcp_server": {
				let mcpServerUse: ClineAskUseMcpServer | null = null
				try {
					mcpServerUse = JSON.parse(message.text || "{}") as ClineAskUseMcpServer
				} catch (e) {
					console.error("Failed to parse use_mcp_server text:", message.text, e)
					return [getIconSpan("error", errorColor), <span>Error parsing MCP request</span>]
				}
				if (!mcpServerUse) {
					return [getIconSpan("error", errorColor), <span>Error parsing MCP request</span>]
				}
				return [
					isMcpServerResponding ? <ProgressIndicator /> : getIconSpan("server", normalColor),
					<span style={{ color: normalColor, fontWeight: "bold", wordBreak: "break-word" }}>
						Clare wants to {mcpServerUse.type === "use_mcp_tool" ? "use a tool" : "access a resource"} on the{" "}
						<code style={{ wordBreak: "break-all" }}>
							{getMcpServerDisplayName(mcpServerUse.serverName, mcpMarketplaceCatalog)}
						</code>{" "}
						MCP server:
					</span>,
				]
			}
			case "completion_result":
				return [
					getIconSpan("check", successColor),
					<span style={{ color: successColor, fontWeight: "bold" }}>Task Completed</span>,
				]
			case "api_req_started": {
				const isCancelled = apiReqCancelReason != null
				const isFailed = apiRequestFailedMessage != null || apiReqStreamingFailedMessage != null
				const isSuccess = cost != null
				const isLoading = !isCancelled && !isFailed && !isSuccess

				if (isLoading && startTime === null) {
					setStartTime(Date.now())
					setFinalElapsedTime(null) // Reset final time when starting
				} else if (!isLoading && startTime !== null) {
					// Request finished, capture final time and stop timer
					if (intervalRef.current) clearInterval(intervalRef.current) // Stop interval immediately
					intervalRef.current = null
					setFinalElapsedTime(elapsedTime) // Store the last elapsed time
					setStartTime(null) // Stop the timer effect
					// Keep elapsedTime as is for one last render cycle if needed, or set to finalElapsedTime
					setElapsedTime(elapsedTime) // Or setElapsedTime(finalElapsedTime) if preferred
				}

				const currentIcon = isCancelled
					? apiReqCancelReason === "user_cancelled"
						? getIconSpan("error", cancelledColor)
						: getIconSpan("error", errorColor)
					: isSuccess
						? getIconSpan("check", successColor)
						: isFailed
							? getIconSpan("error", errorColor)
							: ProgressIndicator()

				const currentTitle = (() => {
					if (isCancelled) {
						return apiReqCancelReason === "user_cancelled" ? (
							<span style={{ color: normalColor, fontWeight: "bold" }}>API Request Cancelled</span>
						) : (
							<span style={{ color: errorColor, fontWeight: "bold" }}>API Streaming Failed</span>
						)
					}
					if (isSuccess) {
						return <span style={{ color: normalColor, fontWeight: "bold" }}>API Request</span>
					}
					if (isFailed) {
						return <span style={{ color: errorColor, fontWeight: "bold" }}>API Request Failed</span>
					}
					// isLoading or showing final time
					const displayTime = isLoading ? elapsedTime : finalElapsedTime
					const timeString = displayTime !== null ? ` (${(displayTime / 1000).toFixed(3)}s)` : ""

					// Title logic: Show "..." only while loading. Otherwise show final status.
					// The time string will be rendered separately in the JSX below.
					if (isLoading) {
						return (
							<span style={{ color: normalColor, fontWeight: "bold" }}>
								API Request...
								{timeString}
							</span>
						)
					} else if (isSuccess) {
						return <span style={{ color: normalColor, fontWeight: "bold" }}>API Request</span>
					} else if (isFailed) {
						return <span style={{ color: errorColor, fontWeight: "bold" }}>API Request Failed</span>
					} else if (isCancelled) {
						return apiReqCancelReason === "user_cancelled" ? (
							<span style={{ color: normalColor, fontWeight: "bold" }}>API Request Cancelled</span>
						) : (
							<span style={{ color: errorColor, fontWeight: "bold" }}>API Streaming Failed</span>
						)
					}
					// Fallback - should ideally not be reached if logic is correct
					return <span style={{ color: normalColor, fontWeight: "bold" }}>API Request</span>
				})() // End of currentTitle calculation

				// Return the icon and the calculated title
				return [currentIcon, currentTitle]
			}
			case "followup": {
				return [
					<span
						className="codicon"
						style={{
							color: normalColor,
							marginBottom: "-1.5px",
						}}>
						👩🏻‍🔬
					</span>,
					<span style={{ color: normalColor, fontWeight: "bold" }}>Clare has a question:</span>,
				]
			}
			default:
				return [null, null]
		}
	}, [
		type,
		cost,
		apiRequestFailedMessage,
		isCommandExecuting,
		apiReqCancelReason,
		isMcpServerResponding,
		message.text,
		startTime,
		elapsedTime,
		finalElapsedTime,
		apiReqStreamingFailedMessage,
		mcpMarketplaceCatalog,
		normalColor,
		errorColor,
		successColor,
		cancelledColor,
		setStartTime,
		setFinalElapsedTime, // Add setFinalElapsedTime dependency
	])

	const headerStyle: React.CSSProperties = {
		display: "flex",
		alignItems: "center",
		gap: "10px",
		marginBottom: "12px",
	}

	const pStyle: React.CSSProperties = {
		margin: 0,
		whiteSpace: "pre-wrap",
		wordBreak: "break-word",
		overflowWrap: "anywhere",
	}

	const tool = useMemo(() => {
		if (message.ask === "tool" || message.say === "tool") {
			try {
				return JSON.parse(message.text || "{}") as ClineSayTool
			} catch (e) {
				console.error("Failed to parse tool text:", message.text, e)
				return null // Return null if parsing fails
			}
		}
		return null
	}, [message.ask, message.say, message.text])

	if (tool) {
		const colorMap = {
			red: "var(--vscode-errorForeground)",
			yellow: "var(--vscode-editorWarning-foreground)",
			green: "var(--vscode-charts-green)",
		}
		const toolIcon = (name: string, color?: string, rotation?: number, title?: string) => (
			<span
				className={`codicon codicon-${name}`}
				style={{
					color: color ? colorMap[color as keyof typeof colorMap] || color : "var(--vscode-foreground)",
					marginBottom: "-1.5px",
					transform: rotation ? `rotate(${rotation}deg)` : undefined,
				}}
				title={title}></span>
		)

		switch (tool.tool) {
			case "editedExistingFile":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("edit")}
							{!tool.operationIsLocatedInWorkspace &&
								toolIcon("sign-out", "yellow", -90, "This file is outside of your workspace")}
							<span style={{ fontWeight: "bold" }}>Clare wants to edit this file:</span>
						</div>
						<CodeAccordian
							// isLoading={message.partial}
							code={tool.content}
							path={tool.path!}
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
						/>
					</>
				)
			case "newFileCreated":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("new-file")}
							{!tool.operationIsLocatedInWorkspace &&
								toolIcon("sign-out", "yellow", -90, "This file is outside of your workspace")}
							<span style={{ fontWeight: "bold" }}>Clare wants to create a new file:</span>
						</div>
						<CodeAccordian
							isLoading={message.partial}
							code={tool.content!}
							path={tool.path!}
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
						/>
					</>
				)
			case "readFile":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("file-code")}
							{!tool.operationIsLocatedInWorkspace &&
								toolIcon("sign-out", "yellow", -90, "This file is outside of your workspace")}
							<span style={{ fontWeight: "bold" }}>Clare wants to read this file:</span>
						</div>
						<div
							style={{
								borderRadius: 3,
								backgroundColor: CODE_BLOCK_BG_COLOR,
								overflow: "hidden",
								border: "1px solid var(--vscode-editorGroup-border)",
							}}>
							<div
								style={{
									color: "var(--vscode-descriptionForeground)",
									display: "flex",
									alignItems: "center",
									padding: "9px 10px",
									cursor: "pointer",
									userSelect: "none",
									WebkitUserSelect: "none",
									MozUserSelect: "none",
									msUserSelect: "none",
								}}
								onClick={() => {
									vscode.postMessage({
										type: "openFile",
										text: tool.path, // Pass path to open
									})
								}}>
								{tool.path?.startsWith(".") && <span>.</span>}
								<span
									style={{
										whiteSpace: "nowrap",
										overflow: "hidden",
										textOverflow: "ellipsis",
										marginRight: "8px",
										direction: "rtl",
										textAlign: "left",
									}}>
									{cleanPathPrefix(tool.path ?? "") + "\u200E"}
								</span>
								<div style={{ flexGrow: 1 }}></div>
								<span
									className={`codicon codicon-link-external`}
									style={{
										fontSize: 13.5,
										margin: "1px 0",
									}}></span>
							</div>
						</div>
					</>
				)
			case "listFilesTopLevel":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("folder-opened")}
							{!tool.operationIsLocatedInWorkspace &&
								toolIcon("sign-out", "yellow", -90, "This is outside of your workspace")}
							<span style={{ fontWeight: "bold" }}>
								{message.type === "ask"
									? "Clare wants to view the top level files in this directory:"
									: "Cline viewed the top level files in this directory:"}
							</span>
						</div>
						<CodeAccordian
							code={tool.content!}
							path={tool.path!}
							language="shell-session"
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
						/>
					</>
				)
			case "listFilesRecursive":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("folder-opened")}
							{!tool.operationIsLocatedInWorkspace &&
								toolIcon("sign-out", "yellow", -90, "This is outside of your workspace")}
							<span style={{ fontWeight: "bold" }}>
								{message.type === "ask"
									? "Clare wants to recursively view all files in this directory:"
									: "Cline recursively viewed all files in this directory:"}
							</span>
						</div>
						<CodeAccordian
							code={tool.content!}
							path={tool.path!}
							language="shell-session"
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
						/>
					</>
				)
			case "listCodeDefinitionNames":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("file-code")}
							{!tool.operationIsLocatedInWorkspace &&
								toolIcon("sign-out", "yellow", -90, "This is outside of your workspace")}
							<span style={{ fontWeight: "bold" }}>
								{message.type === "ask"
									? "Clare wants to view source code definition names used in this directory:"
									: "Cline viewed source code definition names used in this directory:"}
							</span>
						</div>
						<CodeAccordian
							code={tool.content!}
							path={tool.path!}
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
						/>
					</>
				)
			case "searchFiles":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("search")}
							{!tool.operationIsLocatedInWorkspace &&
								toolIcon("sign-out", "yellow", -90, "This is outside of your workspace")}
							<span style={{ fontWeight: "bold" }}>
								Clare wants to search this directory for <code>{tool.regex}</code>:
							</span>
						</div>
						<CodeAccordian
							code={tool.content!}
							path={tool.path! + (tool.filePattern ? `/(${tool.filePattern})` : "")}
							language="plaintext"
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
						/>
					</>
				)
			default:
				return null
		}
	}

	if (message.ask === "command" || message.say === "command") {
		const splitMessage = (text: string) => {
			const outputIndex = text.indexOf(COMMAND_OUTPUT_STRING)
			if (outputIndex === -1) {
				return { command: text, output: "" }
			}
			return {
				command: text.slice(0, outputIndex).trim(),
				output: text
					.slice(outputIndex + COMMAND_OUTPUT_STRING.length)
					.trim()
					.split("")
					.map((char) => {
						switch (char) {
							case "\t":
								return "→   "
							case "\b":
								return "⌫"
							case "\f":
								return "⏏"
							case "\v":
								return "⇳"
							default:
								return char
						}
					})
					.join(""),
			}
		}

		const { command: rawCommand, output } = splitMessage(message.text || "")

		const requestsApproval = rawCommand.endsWith(COMMAND_REQ_APP_STRING)
		const command = requestsApproval ? rawCommand.slice(0, -COMMAND_REQ_APP_STRING.length) : rawCommand

		return (
			<>
				<div style={headerStyle}>
					{icon}
					{title}
				</div>
				<div
					style={{
						borderRadius: 3,
						border: "1px solid var(--vscode-editorGroup-border)",
						overflow: "hidden",
						backgroundColor: CODE_BLOCK_BG_COLOR,
					}}>
					<CodeBlock source={`${"```"}shell\n${command}\n${"```"}`} forceWrap={true} />
					{output.length > 0 && (
						<div style={{ width: "100%" }}>
							<div
								onClick={onToggleExpand}
								style={{
									display: "flex",
									alignItems: "center",
									gap: "4px",
									width: "100%",
									justifyContent: "flex-start",
									cursor: "pointer",
									padding: `2px 8px ${isExpanded ? 0 : 8}px 8px`,
								}}>
								<span className={`codicon codicon-chevron-${isExpanded ? "down" : "right"}`}></span>
								<span style={{ fontSize: "0.8em" }}>Command Output</span>
							</div>
							{isExpanded && <CodeBlock source={`${"```"}shell\n${output}\n${"```"}`} />}
						</div>
					)}
				</div>
				{requestsApproval && (
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 10,
							padding: 8,
							fontSize: "12px",
							color: "var(--vscode-editorWarning-foreground)",
						}}>
						<i className="codicon codicon-warning"></i>
						<span>The model has determined this command requires explicit approval.</span>
					</div>
				)}
			</>
		)
	}

	if (message.ask === "use_mcp_server" || message.say === "use_mcp_server") {
		let useMcpServer: ClineAskUseMcpServer | null = null
		let server: ReturnType<typeof useExtensionState>["mcpServers"][number] | undefined = undefined
		try {
			useMcpServer = JSON.parse(message.text || "{}") as ClineAskUseMcpServer
			if (useMcpServer?.serverName) {
				server = mcpServers.find((s) => s.name === useMcpServer!.serverName)
			}
		} catch (e) {
			console.error("Failed to parse use_mcp_server text:", message.text, e)
			return (
				<div style={{ color: errorColor }}>
					<span className="codicon codicon-error" style={{ marginRight: 5 }}></span>
					Error displaying MCP request details.
				</div>
			)
		}

		if (!useMcpServer) {
			return (
				<div style={{ color: errorColor }}>
					<span className="codicon codicon-error" style={{ marginRight: 5 }}></span>
					Error displaying MCP request details.
				</div>
			)
		}

		return (
			<>
				<div style={headerStyle}>
					{icon}
					{title}
				</div>

				<div
					style={{
						background: "var(--vscode-textCodeBlock-background)",
						borderRadius: "3px",
						padding: "8px 10px",
						marginTop: "8px",
					}}>
					{useMcpServer.type === "access_mcp_resource" && (
						<McpResourceRow
							item={{
								...(findMatchingResourceOrTemplate(
									useMcpServer.uri || "",
									server?.resources,
									server?.resourceTemplates,
								) || {
									name: "",
									mimeType: "",
									description: "",
								}),
								uri: useMcpServer.uri || "",
							}}
						/>
					)}

					{useMcpServer.type === "use_mcp_tool" && (
						<>
							<div onClick={(e) => e.stopPropagation()}>
								<McpToolRow
									tool={{
										name: useMcpServer.toolName || "",
										description:
											server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.description || "",
										autoApprove:
											server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.autoApprove ||
											false,
									}}
									serverName={useMcpServer.serverName}
								/>
							</div>
							{useMcpServer.arguments && useMcpServer.arguments !== "{}" && (
								<div style={{ marginTop: "8px" }}>
									<div
										style={{
											marginBottom: "4px",
											opacity: 0.8,
											fontSize: "12px",
											textTransform: "uppercase",
										}}>
										Arguments
									</div>
									<CodeAccordian
										code={useMcpServer.arguments}
										language="json"
										isExpanded={true}
										onToggleExpand={onToggleExpand}
									/>
								</div>
							)}
						</>
					)}
				</div>
			</>
		)
	}

	// Determine if the request is finished for rendering the final time
	const isApiReqFinished =
		message.say === "api_req_started" &&
		(cost != null || apiReqCancelReason != null || apiRequestFailedMessage != null || apiReqStreamingFailedMessage != null)

	switch (message.type) {
		case "say":
			switch (message.say) {
				case "api_req_started":
					return (
						<>
							<div
								style={{
									...headerStyle,
									marginBottom:
										(cost == null && apiRequestFailedMessage) || apiReqStreamingFailedMessage ? 10 : 0,
									justifyContent: "space-between",
									cursor: "pointer",
									userSelect: "none",
									WebkitUserSelect: "none",
									MozUserSelect: "none",
									msUserSelect: "none",
								}}
								onClick={onToggleExpand}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
									}}>
									{icon}
									{title}
									{/* Render final time separately if finished */}
									{isApiReqFinished && finalElapsedTime !== null && (
										<span style={{ color: normalColor, fontWeight: "normal", marginLeft: "4px" }}>
											({(finalElapsedTime / 1000).toFixed(3)}s)
										</span>
									)}
									<VSCodeBadge
										style={{
											opacity: cost != null && cost > 0 ? 1 : 0,
											marginLeft: isApiReqFinished && finalElapsedTime !== null ? "auto" : undefined, // Adjust margin if time is shown
										}}>
										${Number(cost || 0)?.toFixed(4)}
									</VSCodeBadge>
								</div>
								<span className={`codicon codicon-chevron-${isExpanded ? "up" : "down"}`}></span>
							</div>
							{((cost == null && apiRequestFailedMessage) || apiReqStreamingFailedMessage) && (
								<>
									{(() => {
										const errorData = parseErrorText(apiRequestFailedMessage)
										if (errorData) {
											if (
												errorData.code === "insufficient_credits" &&
												typeof errorData.current_balance === "number" &&
												typeof errorData.total_spent === "number" &&
												typeof errorData.total_promotions === "number" &&
												typeof errorData.message === "string"
											) {
												return (
													<CreditLimitError
														currentBalance={errorData.current_balance}
														totalSpent={errorData.total_spent}
														totalPromotions={errorData.total_promotions}
														message={errorData.message}
													/>
												)
											}
										}
										return (
											<p
												style={{
													...pStyle,
													color: "var(--vscode-errorForeground)",
												}}>
												{apiRequestFailedMessage || apiReqStreamingFailedMessage}
												{apiRequestFailedMessage?.toLowerCase().includes("powershell") && (
													<>
														<br />
														<br />
														It seems like you're having Windows PowerShell issues, please see this{" "}
														<a
															href="https://github.com/cline/cline/wiki/TroubleShooting-%E2%80%90-%22PowerShell-is-not-recognized-as-an-internal-or-external-command%22"
															style={{
																color: "inherit",
																textDecoration: "underline",
															}}>
															troubleshooting guide
														</a>
														.
													</>
												)}
											</p>
										)
									})()}
								</>
							)}
							{isExpanded &&
								message.text && ( // Added check for message.text
									<div style={{ marginTop: "10px" }}>
										<CodeAccordian
											code={JSON.parse(message.text || "{}").request} // Added fallback for parse
											language="markdown"
											isExpanded={true}
											onToggleExpand={onToggleExpand}
										/>
									</div>
								)}
						</>
					)
				case "api_req_finished":
					return null
				case "mcp_server_response":
					return <McpResponseDisplay responseText={message.text || ""} />
				case "text":
					return (
						<div>
							<Markdown markdown={message.text} />
						</div>
					)
				case "reasoning":
					return (
						<>
							{message.text && (
								<div
									onClick={onToggleExpand}
									style={{
										cursor: "pointer",
										color: "var(--vscode-descriptionForeground)",
										fontStyle: "italic",
										overflow: "hidden",
									}}>
									{isExpanded ? (
										<div style={{ marginTop: -3 }}>
											<span style={{ fontWeight: "bold", display: "block", marginBottom: "4px" }}>
												Thinking
												<span
													className="codicon codicon-chevron-down"
													style={{
														display: "inline-block",
														transform: "translateY(3px)",
														marginLeft: "1.5px",
													}}
												/>
											</span>
											{message.text}
										</div>
									) : (
										<div style={{ display: "flex", alignItems: "center" }}>
											<span style={{ fontWeight: "bold", marginRight: "4px" }}>Thinking:</span>
											<span
												style={{
													whiteSpace: "nowrap",
													overflow: "hidden",
													textOverflow: "ellipsis",
													direction: "rtl",
													textAlign: "left",
													flex: 1,
												}}>
												{message.text + "\u200E"}
											</span>
											<span
												className="codicon codicon-chevron-right"
												style={{
													marginLeft: "4px",
													flexShrink: 0,
												}}
											/>
										</div>
									)}
								</div>
							)}
						</>
					)
				case "user_feedback":
					return (
						<div
							style={{
								backgroundColor: "var(--vscode-badge-background)",
								color: "var(--vscode-badge-foreground)",
								borderRadius: "3px",
								padding: "9px",
								whiteSpace: "pre-line",
								wordWrap: "break-word",
							}}>
							<span style={{ display: "block" }}>{highlightMentions(message.text)}</span>
							{message.images && message.images.length > 0 && (
								<Thumbnails images={message.images} style={{ marginTop: "8px" }} />
							)}
						</div>
					)
				case "user_feedback_diff": {
					// Added block scope
					const feedbackTool = JSON.parse(message.text || "{}") as ClineSayTool // Renamed variable
					return (
						<div
							style={{
								marginTop: -10,
								width: "100%",
							}}>
							<CodeAccordian
								diff={feedbackTool.diff!} // Use renamed variable
								isFeedback={true}
								isExpanded={isExpanded}
								onToggleExpand={onToggleExpand}
							/>
						</div>
					)
				}
				case "error":
					return (
						<>
							{title && (
								<div style={headerStyle}>
									{icon}
									{title}
								</div>
							)}
							<p
								style={{
									...pStyle,
									color: "var(--vscode-errorForeground)",
								}}>
								{message.text}
							</p>
						</>
					)
				case "diff_error":
					return (
						<>
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									backgroundColor: "var(--vscode-textBlockQuote-background)",
									padding: 8,
									borderRadius: 3,
									fontSize: 12,
									color: "var(--vscode-foreground)",
									opacity: 0.8,
								}}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										marginBottom: 4,
									}}>
									<i
										className="codicon codicon-warning"
										style={{
											marginRight: 8,
											fontSize: 14,
											color: "var(--vscode-descriptionForeground)",
										}}></i>
									<span style={{ fontWeight: 500 }}>Diff Edit Mismatch</span>
								</div>
								<div>The model used search patterns that don't match anything in the file. Retrying...</div>
							</div>
						</>
					)
				case "clineignore_error":
					return (
						<>
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									backgroundColor: "rgba(255, 191, 0, 0.1)",
									padding: 8,
									borderRadius: 3,
									fontSize: 12,
								}}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										marginBottom: 4,
									}}>
									<i
										className="codicon codicon-error"
										style={{
											marginRight: 8,
											fontSize: 18,
											color: "#FFA500",
										}}></i>
									<span
										style={{
											fontWeight: 500,
											color: "#FFA500",
										}}>
										Access Denied
									</span>
								</div>
								<div>
									Cline tried to access <code>{message.text}</code> which is blocked by the{" "}
									<code>.clineignore</code>
									file.
								</div>
							</div>
						</>
					)
				case "checkpoint_created":
					return (
						<>
							<CheckmarkControl messageTs={message.ts} isCheckpointCheckedOut={message.isCheckpointCheckedOut} />
						</>
					)
				case "load_mcp_documentation":
					return (
						<div
							style={{
								display: "flex",
								alignItems: "center",
								color: "var(--vscode-foreground)",
								opacity: 0.7,
								fontSize: 12,
								padding: "4px 0",
							}}>
							<i className="codicon codicon-book" style={{ marginRight: 6 }} />
							Loading MCP documentation
						</div>
					)
				case "completion_result": {
					// Added block scope
					const hasChanges = message.text?.endsWith(COMPLETION_RESULT_CHANGES_FLAG) ?? false
					const text = hasChanges ? message.text?.slice(0, -COMPLETION_RESULT_CHANGES_FLAG.length) : message.text
					return (
						<>
							<div
								style={{
									...headerStyle,
									marginBottom: "10px",
								}}>
								{icon}
								{title}
								<TaskFeedbackButtons
									messageTs={message.ts}
									isFromHistory={
										!isLast ||
										lastModifiedMessage?.ask === "resume_completed_task" ||
										lastModifiedMessage?.ask === "resume_task"
									}
									style={{
										marginLeft: "auto",
									}}
								/>
							</div>
							<div
								style={{
									color: "var(--vscode-charts-green)",
									paddingTop: 10,
								}}>
								<Markdown markdown={text} />
							</div>
							{message.partial !== true && hasChanges && (
								<div style={{ paddingTop: 17 }}>
									<SuccessButton
										disabled={seeNewChangesDisabled}
										onClick={() => {
											setSeeNewChangesDisabled(true)
											vscode.postMessage({
												type: "taskCompletionViewChanges",
												number: message.ts,
											})
										}}
										style={{
											cursor: seeNewChangesDisabled ? "wait" : "pointer",
											width: "100%",
										}}>
										<i className="codicon codicon-new-file" style={{ marginRight: 6 }} />
										See new changes
									</SuccessButton>
								</div>
							)}
						</>
					)
				}
				case "shell_integration_warning":
					return (
						<>
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									backgroundColor: "rgba(255, 191, 0, 0.1)",
									padding: 8,
									borderRadius: 3,
									fontSize: 12,
								}}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										marginBottom: 4,
									}}>
									<i
										className="codicon codicon-warning"
										style={{
											marginRight: 8,
											fontSize: 18,
											color: "#FFA500",
										}}></i>
									<span
										style={{
											fontWeight: 500,
											color: "#FFA500",
										}}>
										Shell Integration Unavailable
									</span>
								</div>
								<div>
									Cline won't be able to view the command's output. Please update VSCode (
									<code>CMD/CTRL + Shift + P</code> → "Update") and make sure you're using a supported shell:
									zsh, bash, fish, or PowerShell (<code>CMD/CTRL + Shift + P</code> → "Terminal: Select Default
									Profile").{" "}
									<a
										href="https://github.com/cline/cline/wiki/Troubleshooting-%E2%80%90-Shell-Integration-Unavailable"
										style={{
											color: "inherit",
											textDecoration: "underline",
										}}>
										Still having trouble?
									</a>
								</div>
							</div>
						</>
					)
				default:
					return (
						<>
							{title && (
								<div style={headerStyle}>
									{icon}
									{title}
								</div>
							)}
							<div style={{ paddingTop: 10 }}>
								<Markdown markdown={message.text} />
							</div>
						</>
					)
			}
		case "ask":
			switch (message.ask) {
				case "mistake_limit_reached":
					return (
						<>
							<div style={headerStyle}>
								{icon}
								{title}
							</div>
							<p
								style={{
									...pStyle,
									color: "var(--vscode-errorForeground)",
								}}>
								{message.text}
							</p>
						</>
					)
				case "auto_approval_max_req_reached":
					return (
						<>
							<div style={headerStyle}>
								{icon}
								{title}
							</div>
							<p
								style={{
									...pStyle,
									color: "var(--vscode-errorForeground)",
								}}>
								{message.text}
							</p>
						</>
					)
				case "completion_result":
					if (message.text) {
						const hasChanges = message.text.endsWith(COMPLETION_RESULT_CHANGES_FLAG) ?? false
						const text = hasChanges ? message.text.slice(0, -COMPLETION_RESULT_CHANGES_FLAG.length) : message.text
						return (
							<div>
								<div
									style={{
										...headerStyle,
										marginBottom: "10px",
									}}>
									{icon}
									{title}
									<TaskFeedbackButtons
										messageTs={message.ts}
										isFromHistory={
											!isLast ||
											lastModifiedMessage?.ask === "resume_completed_task" ||
											lastModifiedMessage?.ask === "resume_task"
										}
										style={{
											marginLeft: "auto",
										}}
									/>
								</div>
								<div
									style={{
										color: "var(--vscode-charts-green)",
										paddingTop: 10,
									}}>
									<Markdown markdown={text} />
									{message.partial !== true && hasChanges && (
										<div style={{ marginTop: 15 }}>
											<SuccessButton
												appearance="secondary"
												disabled={seeNewChangesDisabled}
												onClick={() => {
													setSeeNewChangesDisabled(true)
													vscode.postMessage({
														type: "taskCompletionViewChanges",
														number: message.ts,
													})
												}}>
												<i
													className="codicon codicon-new-file"
													style={{
														marginRight: 6,
														cursor: seeNewChangesDisabled ? "wait" : "pointer",
													}}
												/>
												See new changes
											</SuccessButton>
										</div>
									)}
								</div>
							</div>
						)
					} else {
						return null
					}
				case "followup": {
					// Added block scope
					let question: string | undefined
					let options: string[] | undefined
					let selected: string | undefined
					try {
						const parsedMessage = JSON.parse(message.text || "{}") as ClineAskQuestion
						question = parsedMessage.question
						options = parsedMessage.options
						selected = parsedMessage.selected
					} catch (e) {
						question = message.text
					}

					return (
						<>
							{title && (
								<div style={headerStyle}>
									{icon}
									{title}
								</div>
							)}
							<div style={{ paddingTop: 10 }}>
								<Markdown markdown={question} />
								<OptionsButtons
									options={options}
									selected={selected}
									isActive={isLast && lastModifiedMessage?.ask === "followup"}
									inputValue={inputValue}
								/>
							</div>
						</>
					)
				}
				case "new_task":
					return (
						<>
							<div style={headerStyle}>
								<span
									className="codicon codicon-new-file"
									style={{
										color: normalColor,
										marginBottom: "-1.5px",
									}}></span>
								<span style={{ color: normalColor, fontWeight: "bold" }}>Clare wants to start a new task:</span>
							</div>
							<NewTaskPreview context={message.text || ""} />
						</>
					)
				case "plan_mode_respond": {
					let response: string | undefined
					let options: string[] | undefined
					let selected: string | undefined
					try {
						const parsedMessage = JSON.parse(message.text || "{}") as ClinePlanModeResponse
						response = parsedMessage.response
						options = parsedMessage.options
						selected = parsedMessage.selected
					} catch (e) {
						response = message.text
					}
					return (
						<div style={{}}>
							<Markdown markdown={response} />
							<OptionsButtons
								options={options}
								selected={selected}
								isActive={isLast && lastModifiedMessage?.ask === "plan_mode_respond"}
								inputValue={inputValue}
							/>
						</div>
					)
				}
				default:
					return null
			}
	}
	// Added default return for the component function itself
	return null
}

function parseErrorText(text: string | undefined) {
	if (!text) {
		return undefined
	}
	try {
		const startIndex = text.indexOf("{")
		const endIndex = text.lastIndexOf("}")
		if (startIndex !== -1 && endIndex !== -1) {
			const jsonStr = text.substring(startIndex, endIndex + 1)
			const errorObject = JSON.parse(jsonStr)
			return errorObject
		}
	} catch (e) {
		// Not JSON or missing required fields
	}
	// Added default return
	return undefined
}
