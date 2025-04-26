export interface ChatSettings {
	mode: "plan" | "act"
	requestsPerMinuteLimit: number // 0 means no limit
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
	mode: "act",
	requestsPerMinuteLimit: 0,
}
