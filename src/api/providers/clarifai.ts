import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandlerOptions } from "../../shared/api"
import axios from "axios" // Import axios
import { ApiHandler } from "../index"
import { ApiStream } from "../transform/stream"
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
		const user_id = "meta"
		const app_id = "Llama-4"
		const model_name = "Llama-4-Scout-17B-16E-Instruct"
		const version_id = "74ea99e833e04fd98ee79abe4e1d7156"
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

			// Check for successful response and extract text
			if (response.status === 200 && response.data?.outputs?.[0]?.data?.text?.raw) {
				const outputText = response.data.outputs[0].data.text.raw
				Logger.info(`Extracted Output Text: ${outputText}`)
				yield { type: "text", text: outputText }
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

	async listAvailableModels(): Promise<string[]> {
		const pat = this.options.clarifaiPat

		if (!pat) {
			Logger.warn("Cannot list Clarifai models without a PAT.")
			return []
		}

		Logger.info("Clarifai listModels called")

		// Returning hardcoded model ID as requested, pending full REST API implementation
		const model_id = "meta/Llama-4/models/Llama-4-Scout-17B-16E-Instruct"
		Logger.info(`Returning hardcoded model: ${model_id}`)
		return [model_id]
	}
}
