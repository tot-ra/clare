import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandlerOptions, ClarifaiModelId, clarifaiDefaultModelId, clarifaiModels, ModelInfo } from "../../shared/api" // Added Clarifai imports
import axios from "axios"
import { ApiHandler } from "../index"
import { ApiStream, ApiStreamChunk } from "../transform/stream"
import { Logger } from "../../services/logging/Logger"
import { parseStringPromise } from "xml2js" // Import xml2js for robust XML parsing

// Placeholder for Clarifai API handler
export class ClarifaiHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private toolUseIdCounter = 0 // Counter for generating tool_use IDs

	constructor(options: ApiHandlerOptions) {
		this.options = options
		// Logger.info("ClarifaiHandler initialized")
	}

	createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		return this.stream(systemPrompt, messages, new AbortController().signal)
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = (this.options.apiModelId || clarifaiDefaultModelId) as ClarifaiModelId
		const modelInfo = clarifaiModels[modelId] || clarifaiModels[clarifaiDefaultModelId]

		return {
			id: modelId,
			info: modelInfo,
		}
	}

	async *stream(systemPrompt: string, messages: Anthropic.MessageParam[], abortSignal: AbortSignal): ApiStream {
		const pat = this.options.clarifaiPat
		const modelId = this.options.apiModelId

		if (!pat) {
			throw new Error("Clarifai Personal Access Token (PAT) is not configured.")
		}

		if (!modelId) {
			throw new Error("Clarifai Model ID is not configured.")
		}

		// Logger.info(`Clarifai stream called for model: ${modelId}`)

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

		// Format the entire message history as a single text string for the Qwen model.
		// Embed tool calls and results in a text-based format.
		let inputText = ""

		if (systemPrompt) {
			inputText += `System: ${systemPrompt}\n\n` // Include system prompt
		}

		for (const msg of messages) {
			if (msg.role === "user") {
				inputText += `User: `
				if (Array.isArray(msg.content)) {
					inputText += msg.content
						.map((item) => {
							if (item.type === "text") {
								return item.text
							}
							return "" // Ignore other types for now
						})
						.join("\n")
				} else {
					inputText += msg.content
				}
				inputText += "\n\n" // Separator between messages
			} else if (msg.role === "assistant") {
				inputText += `Assistant: `
				if (Array.isArray(msg.content)) {
					inputText += msg.content
						.map((item) => {
							if (item.type === "text") {
								return item.text
							}
							return "" // Ignore other types for now
						})
						.join("\n")
				} else {
					inputText += msg.content
				}
				inputText += "\n\n" // Separator between messages
			}
			// Role 'tool' messages are handled as part of user messages with type 'tool_result'
		}

		const requestBody = {
			inputs: [
				{
					data: {
						text: {
							raw: inputText, // Send the formatted input text
						},
					},
				},
			],

			model: {
				model_version: {
					output_info: {
						params: {
							temperature: 0.5,
							max_tokens: 200000,
							top_k: 0.95,
						},
					},
				},
			},
		}

		const headers = {
			Authorization: `Key ${pat}`,
			"Content-Type": "application/json",
		}

		// Logger.info(`Clarifai Request URL: ${url}`)
		// Logger.debug(`Clarifai Request Full Body: ${JSON.stringify(requestBody)}`)
		let requestBodyTxt = JSON.stringify(requestBody)

		// console.log(requestBodyTxt)

		try {
			// log current time
			console.log("Current time before request:", new Date().toISOString())

			console.log("making request to url " + url)
			const response = await axios.post(url, requestBodyTxt, {
				headers: headers,
				signal: abortSignal,
			})
			console.log("got response")
			console.log(response)

			// log current time after request
			console.log("Current time after request:", new Date().toISOString())

			// log time taken for request
			const timeTaken = new Date().getTime() - new Date().getTime()
			console.log(`Time taken for request: ${timeTaken} ms`)

			// Logger.info(`Clarifai Response Status: ${response.status}`)

			if (response.status === 200 && response.data?.outputs?.length > 0) {
				let fullOutputText = ""
				for (const output of response.data.outputs) {
					if (output?.data?.text?.raw) {
						fullOutputText += output.data.text.raw + "\n"
					}
				}

				if (fullOutputText.length > 0) {
					// Logger.info(`Extracted Full Output Text: ${fullOutputText}`)
					yield* this.parseClarifaiOutput(fullOutputText)
				} else {
					Logger.warn("Clarifai response was successful but contained no text output.")
				}
			} else {
				const statusDescription = response.data?.status?.description || "Unknown error"
				const statusCode = response.data?.status?.code || response.status
				// Logger.error(`Clarifai API error: ${statusCode} - ${statusDescription}`)
				console.error(`Full response: ${JSON.stringify(response.data)}`)
				throw new Error(`Clarifai API error (${statusCode}): ${statusDescription} - ${JSON.stringify(response.data)}`)
			}
		} catch (error: any) {
			console.log("Error during Clarifai API request:", error)
			// Logger.error(`Response status: ${error}`)

			// if (axios.isCancel(error)) {
			// 	Logger.info("Clarifai request cancelled.")
			// } else if (axios.isAxiosError(error)) {
			// 	Logger.error(`Clarifai API request failed: ${error.message}`)
			// 	Logger.error(`Response status: ${error.response?.status}`)
			// 	Logger.error(`Response data: ${JSON.stringify(error.response?.data)}`)
			// 	const statusDescription = error.response?.data?.status?.description || error.message
			// 	const statusCode = error.response?.data?.status?.code || error.response?.status || "Network Error"
			// 	throw new Error(`Clarifai API error (${statusCode}): ${statusDescription}`)
			// } else {
			// 	Logger.error(`Clarifai stream error: ${error}`)
			// 	throw new Error(`Clarifai stream error: ${error instanceof Error ? error.message : String(error)}`)
			// }
		}
	}

	private async *parseClarifaiOutput(outputText: string): AsyncGenerator<ApiStreamChunk, void, unknown> {
		// Regex to find blocks like <tag>...</tag> or tool_code/tool_result blocks
		// Refined regex to be more robust to whitespace and optional language identifiers
		const blockRegex =
			/<(task|environment_details|thinking)>(.*?)<\/\1>|tool_code\s*```(?:\w+)?\s*\n(.*?)\s*```|tool_result\s*```(?:\w+)?\s*\n(.*?)\s*```/gs
		let lastIndex = 0
		let match

		while ((match = blockRegex.exec(outputText)) !== null) {
			const fullMatch = match[0]
			const tag = match[1] // For <tag>...</tag>
			const tagContent = match[2] // Content for <tag>...</tag>
			const toolCodeContent = match[3] // Content for tool_code block
			const toolResultContent = match[4] // Content for tool_result block
			const startIndex = match.index

			if (startIndex > lastIndex) {
				yield { type: "text", text: outputText.substring(lastIndex, startIndex) }
			}

			if (tag) {
				// Handle <task>, <environment_details>, <thinking> tags
				switch (tag) {
					case "task":
					case "environment_details":
					case "thinking":
						yield { type: "text", text: fullMatch }
						break
					default:
						yield { type: "text", text: fullMatch }
						break
				}
			} else if (toolCodeContent !== undefined) {
				// Handle tool_code block
				try {
					const toolCall = JSON.parse(toolCodeContent.trim())
					// Assuming the JSON structure is { "tool_name": "...", "parameters": { ... } }
					const toolName = toolCall.tool_name
					const toolContent = JSON.stringify(toolCall.parameters)
					const toolUseId = `tool_use_${this.toolUseIdCounter++}` // Generate a unique ID
					yield { type: "tool_use", name: toolName, content: toolContent, id: toolUseId }
				} catch (e: any) {
					// Logger.error(`Failed to parse tool_code JSON content: ${toolCodeContent}`, e)
					yield { type: "text", text: fullMatch } // Yield as text if parsing fails
				}
			} else if (toolResultContent !== undefined) {
				// Handle tool_result block - currently just yield as text as we don't process these incoming
				// from the model, only send them to the model.
				yield { type: "text", text: fullMatch }
			}

			lastIndex = blockRegex.lastIndex
		}

		if (lastIndex < outputText.length) {
			yield { type: "text", text: outputText.substring(lastIndex) }
		}
	}

	async listAvailableModels(): Promise<string[]> {
		// Return models defined in the shared api.ts
		return Object.keys(clarifaiModels)
	}
}
