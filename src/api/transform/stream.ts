export type ApiStream = AsyncGenerator<ApiStreamChunk>
export type ApiStreamChunk =
	| ApiStreamTextChunk
	| ApiStreamReasoningChunk
	| ApiStreamUsageChunk
	| ApiStreamToolCodeChunk // Added tool_code chunk type
	| ApiStreamToolUseChunk // Added tool_use chunk type

export interface ApiStreamTextChunk {
	type: "text"
	text: string
}

export interface ApiStreamReasoningChunk {
	type: "reasoning"
	reasoning: string
}

export interface ApiStreamUsageChunk {
	type: "usage"
	inputTokens: number
	outputTokens: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	totalCost?: number // openrouter
}

// Added interface for tool_code chunks
export interface ApiStreamToolCodeChunk {
	type: "tool_code"
	tool_code: string
}

// Added interface for tool_use chunks
export interface ApiStreamToolUseChunk {
	type: "tool_use"
	name: string
	content: string
	id: string // Assuming tool_use chunks need an ID
}
