import rules from "./rules";

export default {
	plugins: {
		internal: {
			rules,
		},
	},
	rules: {
		"internal/replace-import": [
			"error",
			[{ from: "multiformats/dist/src", to: "multiformats" }],
		],
	},
};
