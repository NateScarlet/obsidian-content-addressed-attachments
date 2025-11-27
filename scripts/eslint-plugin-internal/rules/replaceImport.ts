import createRule from "./createRule";

export default createRule({
	name: "replace-import",
	defaultOptions: [
		[] as {
			from: string;
			to: string;
		}[],
	],
	meta: {
		schema: [
			{
				type: "array",
				items: {
					type: "object",
					properties: {
						from: {
							type: "string",
						},
						to: {
							type: "string",
						},
					},
					required: ["from", "to"],
				},
				minItems: 1,
			},
		],
		type: "suggestion",
		docs: {
			description: "替换指定的导入",
		},
		fixable: "code",
		messages: {
			shouldReplace: "请使用 '{{to}}' 替代 '{{from}}'",
		},
	},
	create(context, [replacements]) {
		const mapping = new Map<string, string>();
		replacements.forEach(({ from, to }) => {
			if (!from) {
				throw new Error("`from` is required");
			}
			if (!to) {
				throw new Error("`to` is required");
			}
			if (mapping.has(from)) {
				throw new Error(`duplicated from '${from}' is not allowed`);
			}
			mapping.set(from, to);
		});
		return {
			ImportDeclaration: (node) => {
				const from = node.source.value;
				const to = mapping.get(from);
				if (to) {
					context.report({
						node,
						messageId: "shouldReplace",
						data: { from, to },
						fix: (fixer) =>
							fixer.replaceText(
								node.source,
								context.sourceCode
									.getText(node.source)
									.replace(from, to),
							),
					});
				}
			},
		};
	},
});
