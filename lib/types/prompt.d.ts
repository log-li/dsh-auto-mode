export interface PromptInput {
    readonly toolName: string;
    readonly reason?: string;
    readonly allowRules: readonly string[];
    readonly denyRules: readonly string[];
    readonly environmentFacts: readonly string[];
    /** The user's most recent explicit instructions (CC-style intent). */
    readonly userIntent?: string;
}
/**
 * Build the system prompt: safety monitor role + operator rules + decision
 * contract. Model-agnostic: demands terse JSON-only output.
 */
export declare function buildSystemPrompt(input: PromptInput): string;
/**
 * Build the user message: the action being decided.
 */
export declare function buildUserMessage(input: PromptInput, transcript: string): string;
/** Shrink a request to the fields the prompt cares about. */
export declare function promptInputOf(req: {
    toolName: string;
    reason?: string;
    userIntent?: string;
}, allowRules: readonly string[], denyRules: readonly string[], environmentFacts: readonly string[]): PromptInput;
