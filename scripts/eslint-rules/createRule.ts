import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
	(name) => `${import.meta.url}#${name}`,
);

export default createRule;
