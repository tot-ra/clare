import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandlerOptions } from "../../shared/api"
import axios from "axios"
import { ApiHandler } from "../index"
import { ApiStream, ApiStreamChunk } from "../transform/stream"
import { Logger } from "../../services/logging/Logger"
import { ModelInfo } from "../../shared/api"
import { parseStringPromise } from "xml2js" // Import xml2js for robust XML parsing

// Placeholder for Clarifai API handler
export class ClarifaiHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private toolUseIdCounter = 0 // Counter for generating tool_use IDs

	constructor(options: ApiHandlerOptions) {
		this.options = options
		Logger.info("ClarifaiHandler initialized")
	}

	createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		// This should eventually call the stream method with the formatted messages
		return this.stream(messages, new AbortController().signal) // Using a dummy signal for now
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.apiModelId || "clarifai-default",
			info: { supportsPromptCache: false },
		}
	}

	async *stream(messages: Anthropic.MessageParam[], abortSignal: AbortSignal): ApiStream {
		const pat = this.options.clarifaiPat
		const modelId = this.options.apiModelId

		if (!pat) {
			throw new Error("Clarifai Personal Access Token (PAT) is not configured.")
		}

		if (!modelId) {
			throw new Error("Clarifai Model ID is not configured.")
		}

		Logger.info(`Clarifai stream called for model: ${modelId}`)

		// Extract user_id, app_id, model_name, and version_id from the modelId
		const modelParts = modelId.split("/")
		if (modelParts.length !== 4 || modelParts[2] !== "models") {
			throw new Error(`Invalid Clarifai Model ID format: ${modelId}. Expected format: user_id/app_id/models/model_name.`)
		}
		const user_id = modelParts[0]
		const app_id = modelParts[1]
		const model_name = modelParts[3]
		// Assuming latest version if not specified in modelId, or if the API handles it
		const version_id = this.options.clarifaiModelVersionId || "latest" // Use configured version or 'latest'

		const baseUrl = this.options.clarifaiApiBaseUrl || "https://api.clarifai.com"
		const url = `${baseUrl}/v2/users/${user_id}/apps/${app_id}/models/${model_name}/outputs`

		// Format messages for the Qwen model, including tool calls
		const formattedMessages = messages
			.map((msg) => {
				if (msg.role === "user") {
					return { role: "user", content: msg.content }
				} else if (msg.role === "assistant") {
					// Assuming assistant content can be text or an array of text and tool_use
					if (Array.isArray(msg.content)) {
						const content: any[] = []
						for (const item of msg.content) {
							if (item.type === "text") {
								content.push({ type: "text", text: item.text })
							} else if (item.type === "tool_use") {
								// Format tool_use for the model if needed, otherwise include as text
								// This part might need adjustment based on Qwen's specific tool call format
								// Casting to any to access id and content, as the exact type is not ToolUseBlockParam
								const toolUseItem = item as any
								content.push({
									type: "text",
									text: `<tool_use id="${toolUseItem.id}">${toolUseItem.content}</tool_use>`,
								})
							}
						}
						return { role: "assistant", content: content }
					} else {
						return { role: "assistant", content: [{ type: "text", text: msg.content }] }
					}
				} else if (msg.role === "tool") {
					// Assuming tool results are sent back as user messages with tool_result content
					// Casting to any to access tool_use_id and content
					const toolMessage = msg as any
					return {
						role: "user",
						content: [{ type: "tool_result", tool_use_id: toolMessage.tool_use_id, content: toolMessage.content }],
					}
				}
				return null // Should not happen with valid message roles
			})
			.filter((msg) => msg !== null)

		const requestBody = {
			inputs: [
				{
					data: {
						text: {
							raw: JSON.stringify(formattedMessages), // Send formatted messages as JSON string
						},
					},
				},
			],
		}

		const headers = {
			Authorization: `Key ${pat}`,
			"Content-Type": "application/json",
		}

		Logger.info(`Clarifai Request URL: ${url}`)
		Logger.info(`Clarifai Request Headers: ${JSON.stringify(headers)}`)
		Logger.debug(`Clarifai Request Full Body: ${JSON.stringify(requestBody)}`)
		let requestBodyTxt = JSON.stringify(requestBody)

		console.log(requestBodyTxt)

		try {
			const response = await axios.post(url, requestBodyTxt, {
				headers: headers,
				signal: abortSignal,
			})
			console.log(response)

			Logger.info(`Clarifai Response Status: ${response.status}`)
			Logger.info(`Clarifai Raw Response Data: ${JSON.stringify(response.data, null, 2)}`)

			if (response.status === 200 && response.data?.outputs?.length > 0) {
				let fullOutputText = ""
				for (const output of response.data.outputs) {
					if (output?.data?.text?.raw) {
						fullOutputText += output.data.text.raw + "\n"
					}
				}

				if (fullOutputText.length > 0) {
					Logger.info(`Extracted Full Output Text: ${fullOutputText}`)
					yield* this.parseClarifaiOutput(fullOutputText)
				} else {
					Logger.warn("Clarifai response was successful but contained no text output.")
				}
			} else {
				const statusDescription = response.data?.status?.description || "Unknown error"
				const statusCode = response.data?.status?.code || response.status
				Logger.error(`Clarifai API error: ${statusCode} - ${statusDescription}`)
				Logger.error(`Full response: ${JSON.stringify(response.data)}`)
				throw new Error(`Clarifai API error (${statusCode}): ${statusDescription}`)
			}
		} catch (error: any) {
			if (axios.isCancel(error)) {
				Logger.info("Clarifai request cancelled.")
			} else if (axios.isAxiosError(error)) {
				Logger.error(`Clarifai API request failed: ${error.message}`)
				Logger.error(`Response status: ${error.response?.status}`)
				Logger.error(`Response data: ${JSON.stringify(error.response?.data)}`)
				const statusDescription = error.response?.data?.status?.description || error.message
				const statusCode = error.response?.data?.status?.code || error.response?.status || "Network Error"
				throw new Error(`Clarifai API error (${statusCode}): ${statusDescription}`)
			} else {
				Logger.error(`Clarifai stream error: ${error}`)
				throw new Error(`Clarifai stream error: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
	}

	private async *parseClarifaiOutput(outputText: string): AsyncGenerator<ApiStreamChunk, void, unknown> {
		const blockRegex = /<(task|environment_details|tool_code|tool_use|thinking)>(.*?)<\/\1>/gs
		let lastIndex = 0
		let match

		while ((match = blockRegex.exec(outputText)) !== null) {
			const fullMatch = match[0]
			const tag = match[1]
			const content = match[2].trim()
			const startIndex = match.index

			if (startIndex > lastIndex) {
				yield { type: "text", text: outputText.substring(lastIndex, startIndex) }
			}

			switch (tag) {
				case "task":
				case "environment_details":
				case "thinking":
					yield { type: "text", text: fullMatch }
					break
				case "tool_code":
					yield { type: "tool_code", tool_code: content }
					break
				case "tool_use":
					try {
						// Use xml2js to parse the tool_use content
						const result: any = await parseStringPromise(`<root>${content}</root>`, {
							explicitArray: false,
							strict: false,
						})
						const toolName = Object.keys(result.root)[0]
						const toolContent = result.root[toolName]
						const toolUseId = `tool_use_${this.toolUseIdCounter++}` // Generate a unique ID
						yield { type: "tool_use", name: toolName, content: JSON.stringify(toolContent), id: toolUseId }
					} catch (e: any) {
						Logger.error(`Failed to parse tool_use content with xml2js: ${content}`, e)
						yield { type: "text", text: fullMatch }
					}
					break
				default:
					yield { type: "text", text: fullMatch }
					break
			}

			lastIndex = blockRegex.lastIndex
		}

		if (lastIndex < outputText.length) {
			yield { type: "text", text: outputText.substring(lastIndex) }
		}
	}

	async listAvailableModels(): Promise<string[]> {
		const pat = this.options.clarifaiPat

		if (!pat) {
			Logger.warn("Cannot list Clarifai models without a PAT.")
			return []
		}

		Logger.info("Clarifai listModels called")

		// Returning hardcoded model ID as requested, pending full REST API implementation
		const model_id = "qwen/qwenCoder/models/Qwen2_5-Coder-7B-Instruct-vllm"
		Logger.info(`Returning hardcoded model: ${model_id}`)
		return [model_id]
	}
}
