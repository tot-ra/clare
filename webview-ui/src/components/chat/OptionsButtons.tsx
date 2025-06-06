import styled from "styled-components"
import { CODE_BLOCK_BG_COLOR } from "@/components/common/CodeBlock"
import { vscode } from "@/utils/vscode"

const OptionButton = styled.button<{ isSelected?: boolean; isNotSelectable?: boolean }>`
	padding: 8px 12px;
	background: ${(props) => (props.isSelected ? "var(--vscode-focusBorder)" : CODE_BLOCK_BG_COLOR)};
	color: ${(props) => (props.isSelected ? "white" : "var(--vscode-input-foreground)")};
	border: 1px solid var(--vscode-editorGroup-border);
	border-radius: 2px;
	cursor: ${(props) => (props.isNotSelectable ? "default" : "pointer")};
	text-align: left;
	font-size: 0.9rem;

	${(props) =>
		!props.isNotSelectable &&
		`
		&:hover {
			background: var(--vscode-focusBorder);
			color: white;
		}
	`}
`

export const OptionsButtons = ({
	options,
	selected,
	isActive,
	inputValue,
}: {
	options?: string[]
	selected?: string
	isActive?: boolean
	inputValue?: string
}) => {
	if (!options?.length) return null

	const hasSelected = selected !== undefined && options.includes(selected)

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				paddingTop: 15,
				// marginTop: "22px",
			}}>
			{options.map((option, index) => (
				<OptionButton
					key={index}
					isSelected={option === selected}
					isNotSelectable={hasSelected || !isActive}
					onClick={() => {
						if (hasSelected || !isActive) {
							return
						}
						vscode.postMessage({
							type: "optionsResponse",
							text: option + (inputValue ? `: ${inputValue?.trim()}` : ""),
						})
					}}>
					{option}
				</OptionButton>
			))}
		</div>
	)
}
