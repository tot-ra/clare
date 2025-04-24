import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandlerOptions } from "../../shared/api"
import axios from "axios" // Import axios
import { ApiHandler } from "../index"
import { ApiStream, ApiStreamChunk } from "../transform/stream" // Import ApiStreamChunk
import { Logger } from "../../services/logging/Logger"
import { ModelInfo } from "../../shared/api"

// Placeholder for Clarifai API handler
export class ClarifaiHandler implements ApiHandler {
	private options: ApiHandlerOptions

	constructor(options: ApiHandlerOptions) {
		this.options = options
		Logger.info("ClarifaiHandler initialized") // Use Logger class directly
	}

	// Placeholder implementation for createMessage
	createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		// This should eventually call the stream method with the formatted messages
		return this.stream(messages, new AbortController().signal) // Using a dummy signal for now
	}

	// Placeholder implementation for getModel
	getModel(): { id: string; info: ModelInfo } {
		// Return placeholder model info; this should be updated when model listing is implemented
		return {
			id: this.options.apiModelId || "clarifai-default", // Use configured or default ID
			info: { supportsPromptCache: false }, // Basic placeholder info
		}
	}

	async *stream(messages: Anthropic.MessageParam[], abortSignal: AbortSignal): ApiStream {
		const pat = this.options.clarifaiPat
		const modelId = this.options.apiModelId

		if (!pat) {
			throw new Error("Clarifai Personal Access Token (PAT) is not configured.")
		}

		Logger.info(`Clarifai stream called for model: ${modelId}`)

		// Construct the API endpoint URL
		// Using the specific model and version provided in the task description
		const user_id = "qwen"
		const app_id = "qwenCoder"
		const model_name = "Qwen2_5-Coder-7B-Instruct-vllm"
		const version_id = "045f032cd56c4be8b06972b04e7d2b81" // Optional: defaults to latest if omitted
		const baseUrl = this.options.clarifaiApiBaseUrl || "https://api.clarifai.com"
		const url = `${baseUrl}/v2/users/${user_id}/apps/${app_id}/models/${model_name}/versions/${version_id}/outputs`

		// Combine messages into a single raw text input
		// A more sophisticated approach might be needed depending on the model's requirements
		const rawInput = messages.map((msg) => JSON.stringify(msg.content)).join("\n")

		const requestBody = {
			inputs: [
				{
					data: {
						text: {
							raw: rawInput,
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
		Logger.info(`Clarifai Request Raw Input: ${rawInput}`)
		Logger.debug(`Clarifai Request Full Body: ${JSON.stringify(requestBody)}`)
		let requestBodyTxt = JSON.stringify(requestBody)

		console.log(requestBodyTxt)

		try {
			const response = await axios.post(url, requestBodyTxt, {
				headers: headers,
				signal: abortSignal, // Pass the abort signal
			})
			console.log(response)

			Logger.info(`Clarifai Response Status: ${response.status}`)
			// Log the full raw response data for detailed inspection
			Logger.info(`Clarifai Raw Response Data: ${JSON.stringify(response.data, null, 2)}`)

			// Check for successful response and extract text from all outputs
			if (response.status === 200 && response.data?.outputs?.length > 0) {
				let fullOutputText = ""
				for (const output of response.data.outputs) {
					if (output?.data?.text?.raw) {
						fullOutputText += output.data.text.raw + "\n" // Concatenate text from all outputs
					}
				}

				if (fullOutputText.length > 0) {
					Logger.info(`Extracted Full Output Text: ${fullOutputText}`)
					// Parse the fullOutputText for internal Cline format/tasks blocks
					yield* this.parseClarifaiOutput(fullOutputText) // Use the new parsing function
				} else {
					Logger.warn("Clarifai response was successful but contained no text output.")
					// Optionally yield a message indicating no output
					// yield { type: "text", text: "Received a successful response with no text output." };
				}
			} else {
				// Handle potential errors or unexpected response structure
				const statusDescription = response.data?.status?.description || "Unknown error"
				const statusCode = response.data?.status?.code || response.status
				Logger.error(`Clarifai API error: ${statusCode} - ${statusDescription}`)
				Logger.error(`Full response: ${JSON.stringify(response.data)}`)
				throw new Error(`Clarifai API error (${statusCode}): ${statusDescription}`)
			}
		} catch (error: any) {
			if (axios.isCancel(error)) {
				Logger.info("Clarifai request cancelled.")
				// Don't re-throw cancellation errors
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

		// Example of how to yield final usage stats:
		// yield { type: "usage", usage: { input_tokens: 10, output_tokens: 20 } }
	}

	// Helper function to parse Clarifai output text for Cline format/tasks blocks
	private *parseClarifaiOutput(outputText: string): Generator<ApiStreamChunk, void, unknown> {
		const blockRegex = /<(task|environment_details|tool_code|tool_use|thinking)>(.*?)<\/\1>/gs
		let lastIndex = 0
		let match

		while ((match = blockRegex.exec(outputText)) !== null) {
			const fullMatch = match[0]
			const tag = match[1]
			const content = match[2].trim()
			const startIndex = match.index

			// Yield preceding text if any
			if (startIndex > lastIndex) {
				yield { type: "text", text: outputText.substring(lastIndex, startIndex) }
			}

			// Yield the block content based on tag type
			switch (tag) {
				case "task":
				case "environment_details":
				case "thinking":
					yield { type: "text", text: fullMatch } // Yield the full tag and content for these types
					break
				case "tool_code":
					yield { type: "tool_code", tool_code: content }
					break
				case "tool_use":
					// Attempt to parse tool_use content as XML
					try {
						// A more robust XML parser might be needed for complex tool_use blocks
						const toolNameMatch = content.match(/<([^>]+)>/)
						const toolName = toolNameMatch ? toolNameMatch[1] : "unknown_tool"
						yield { type: "tool_use", name: toolName, content: content, id: `tool_use_id_${Date.now()}` } // Generate a simple ID
					} catch (e) {
						Logger.error(`Failed to parse tool_use content: ${content}`, e)
						yield { type: "text", text: fullMatch } // Yield as text if parsing fails
					}
					break
				default:
					yield { type: "text", text: fullMatch } // Yield unrecognized tags as text
					break
			}

			lastIndex = blockRegex.lastIndex
		}

		// Yield any remaining text after the last block
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
