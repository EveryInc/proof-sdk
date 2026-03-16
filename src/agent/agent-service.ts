/**
 * Agent Service for Proof
 *
 * Core agent loop using the Anthropic SDK.
 * Handles:
 * - Agent session management
 * - Streaming responses
 * - Tool execution
 * - Extended thinking display
 * - Timeout/cancellation
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  TextBlock,
  ToolUseBlock,
  ThinkingBlock,
} from '@anthropic-ai/sdk/resources/messages';
import { getAgentConfig } from './config';
import { getSystemPrompt } from './prompts/system';
import { getAllTools, executeTool } from './tools';
import type { AgentTask, AgentResponse, ThinkingChainEvent, ToolCallRecord, AgentTool } from './types';

// ============================================================================
// Types
// ============================================================================

export interface AgentSession {
  id: string;
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'error';
  task: AgentTask;
  startedAt: number;
  completedAt: number | null;
  thinkingChain: ThinkingChainEvent[];
  response: AgentResponse | null;
  error: string | null;
}

export interface AgentServiceCallbacks {
  onThinkingUpdate?: (event: ThinkingChainEvent) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
  onStreamingText?: (text: string) => void;
  onComplete?: (response: AgentResponse) => void;
  onError?: (error: Error) => void;
  onStatusChange?: (status: AgentSession['status']) => void;
  onTokenUsage?: (inputTokens: number, outputTokens: number) => void;
}

interface AgentRuntimeConfig {
  maxTokens: number;
  thinkingBudgetTokens: number;
}

// ============================================================================
// Agent Service Class
// ============================================================================

export class AgentService {
  private currentSession: AgentSession | null = null;
  private abortController: AbortController | null = null;
  private callbacks: AgentServiceCallbacks = {};
  private timeoutMs: number = 5 * 60 * 1000; // 5 minutes default
  private client: Anthropic | null = null;

  constructor() {}

  /**
   * Set callbacks for agent events
   */
  setCallbacks(callbacks: AgentServiceCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Set the timeout for agent runs
   */
  setTimeout(ms: number): void {
    this.timeoutMs = ms;
  }

  /**
   * Get current session status
   */
  getSession(): AgentSession | null {
    return this.currentSession;
  }

  /**
   * Check if agent is currently running
   */
  isRunning(): boolean {
    return this.currentSession?.status === 'running';
  }

  /**
   * Force reset the agent state (useful for recovering from stuck sessions)
   */
  reset(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = null;
    this.currentSession = null;
    this.client = null;
  }

  /**
   * Start an agent task
   */
  async run(task: AgentTask): Promise<AgentResponse> {
    const config = getAgentConfig();
    if (!config.apiKey) {
      const error = new Error(
        'Anthropic API key not configured. Call setApiKey() before running the agent.'
      );
      console.error('[AgentService]', error.message);
      throw error;
    }

    // Auto-reset if session is stale (older than 5 minutes)
    if (this.currentSession) {
      const sessionAge = Date.now() - this.currentSession.startedAt;
      const fiveMinutes = 5 * 60 * 1000;
      if (sessionAge > fiveMinutes || this.currentSession.status !== 'running') {
        console.log('[AgentService] Resetting stale session');
        this.reset();
      }
    }

    if (this.isRunning()) {
      throw new Error('Agent is already running. Cancel the current task first.');
    }

    // Create new session
    const sessionId = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.currentSession = {
      id: sessionId,
      status: 'running',
      task,
      startedAt: Date.now(),
      completedAt: null,
      thinkingChain: [],
      response: null,
      error: null,
    };

    this.abortController = new AbortController();
    this.callbacks.onStatusChange?.('running');

    try {
      const response = await this.executeAgent(task);

      this.currentSession.status = 'completed';
      this.currentSession.completedAt = Date.now();
      this.currentSession.response = response;
      this.callbacks.onStatusChange?.('completed');
      this.callbacks.onComplete?.(response);

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes('aborted') || errorMessage.includes('cancelled')) {
        this.currentSession.status = 'cancelled';
        this.callbacks.onStatusChange?.('cancelled');
      } else {
        this.currentSession.status = 'error';
        this.currentSession.error = errorMessage;
        this.callbacks.onStatusChange?.('error');
        this.callbacks.onError?.(error instanceof Error ? error : new Error(errorMessage));
      }

      this.currentSession.completedAt = Date.now();
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Cancel the current agent run
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Execute the agent with the Anthropic SDK
   */
  private async executeAgent(task: AgentTask): Promise<AgentResponse> {
    const config = getAgentConfig();
    const systemPrompt = getSystemPrompt(task);
    const tools = getAllTools(task.context);
    const runtimeConfig = this.getRuntimeConfig();

    if (!this.client) {
      this.client = new Anthropic({
        apiKey: config.apiKey,
        dangerouslyAllowBrowser: true,
      });
    }

    // Build the initial message based on the task
    const userMessage = this.buildUserMessage(task);

    // Set up timeout
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Agent timeout: exceeded ${this.timeoutMs / 1000} seconds`));
      }, this.timeoutMs);
    });

    // Execute agent with SDK
    const agentPromise = this.runAgentLoop(
      config.model,
      systemPrompt,
      userMessage,
      tools,
      runtimeConfig
    );

    // Race between agent completion and timeout
    try {
      return await Promise.race([agentPromise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Convert our tool format to Anthropic API format
   */
  private convertToolsToAnthropicFormat(tools: AgentTool[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  /**
   * Run the agent loop using Anthropic SDK
   */
  private async runAgentLoop(
    model: string,
    systemPrompt: string,
    userMessage: string,
    tools: AgentTool[],
    runtimeConfig: AgentRuntimeConfig
  ): Promise<AgentResponse> {
    const messages: MessageParam[] = [
      { role: 'user', content: userMessage }
    ];

    const response: AgentResponse = {
      text: '',
      toolCalls: [],
      thinkingChain: this.currentSession?.thinkingChain || [],
    };

    const anthropicTools = this.convertToolsToAnthropicFormat(tools);
    let continueLoop = true;

    while (continueLoop) {
      // Check if aborted
      if (this.abortController?.signal.aborted) {
        throw new Error('Agent cancelled by user');
      }

      try {
        // Make API call with extended thinking enabled
        let result: Anthropic.Message;

        console.log(`[AgentService] Making API call, model: ${model}`);
        console.log(`[AgentService] Message count: ${messages.length}, tools count: ${anthropicTools.length}`);

        const request = {
          model,
          max_tokens: runtimeConfig.maxTokens,
          system: systemPrompt,
          messages,
          tools: anthropicTools,
        };
        if (runtimeConfig.thinkingBudgetTokens > 0) {
          request.thinking = {
            type: 'enabled',
            budget_tokens: runtimeConfig.thinkingBudgetTokens,
          };
        }
        result = await this.client!.messages.create(request, {
          signal: this.abortController?.signal ?? undefined,
        });

        if (this.abortController?.signal.aborted) {
          throw new Error('Agent cancelled by user');
        }

        if (result.usage) {
          this.callbacks.onTokenUsage?.(
            result.usage.input_tokens ?? 0,
            result.usage.output_tokens ?? 0
          );
        }

        // Process the response content blocks
        const toolUseBlocks: ToolUseBlock[] = [];

        for (const block of result.content) {
          if (block.type === 'thinking') {
            // Handle extended thinking
            const thinkingBlock = block as ThinkingBlock;
            const event: ThinkingChainEvent = {
              type: 'thinking',
              content: thinkingBlock.thinking,
              timestamp: Date.now(),
            };
            this.currentSession?.thinkingChain.push(event);
            this.callbacks.onThinkingUpdate?.(event);
          } else if (block.type === 'text') {
            // Handle text response
            const textBlock = block as TextBlock;
            response.text += textBlock.text;
            this.callbacks.onStreamingText?.(textBlock.text);
          } else if (block.type === 'tool_use') {
            // Handle tool use
            const toolBlock = block as ToolUseBlock;
            toolUseBlocks.push(toolBlock);

            const event: ThinkingChainEvent = {
              type: 'tool_call',
              toolName: toolBlock.name,
              args: toolBlock.input as Record<string, unknown>,
              timestamp: Date.now(),
            };
            this.currentSession?.thinkingChain.push(event);
            this.callbacks.onToolCall?.(toolBlock.name, toolBlock.input as Record<string, unknown>);
          }
        }

        // If there are tool uses, execute them and continue the loop
        if (toolUseBlocks.length > 0) {
          // Add assistant message with tool uses
          messages.push({
            role: 'assistant',
            content: result.content as ContentBlockParam[],
          });

          // Execute tools and collect results
          const toolResults: ToolResultBlockParam[] = [];

          for (const toolBlock of toolUseBlocks) {
            const toolResult = await executeTool(
              toolBlock.name,
              toolBlock.input as Record<string, unknown>,
              this.currentSession?.task.context
            );

            // Record the tool call
            const toolCallRecord: ToolCallRecord = {
              name: toolBlock.name,
              args: toolBlock.input as Record<string, unknown>,
              result: toolResult,
              timestamp: Date.now(),
            };
            response.toolCalls.push(toolCallRecord);

            // Emit tool result event
            const resultEvent: ThinkingChainEvent = {
              type: 'tool_result',
              toolName: toolBlock.name,
              result: toolResult,
              timestamp: Date.now(),
            };
            this.currentSession?.thinkingChain.push(resultEvent);
            this.callbacks.onToolResult?.(toolBlock.name, toolResult);

            // Add to results
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(toolResult),
            });
          }

          // Add tool results message
          messages.push({
            role: 'user',
            content: toolResults,
          });

          // Continue the loop
          continueLoop = true;
        } else {
          // No tool uses, we're done
          continueLoop = false;
        }

        // Check stop reason
        if (result.stop_reason === 'end_turn' || result.stop_reason === 'stop_sequence') {
          continueLoop = false;
        }
      } catch (error) {
        // Check if aborted
        if (this.abortController?.signal.aborted) {
          throw new Error('Agent cancelled by user');
        }
        throw error;
      }
    }

    return response;
  }

  private getRuntimeConfig(): AgentRuntimeConfig {
    return {
      maxTokens: 16000,
      thinkingBudgetTokens: 10000,
    };
  }

  /**
   * Build the user message based on the task type
   */
  private buildUserMessage(task: AgentTask): string {
    switch (task.type) {
      case 'comment-response':
        return this.buildCommentResponseMessage(task);
      case 'document-edit':
        return this.buildDocumentEditMessage(task);
      case 'inline-mention':
        return this.buildInlineMentionMessage(task);
      default:
        return task.prompt || 'Please help me with this document.';
    }
  }

  /**
   * Build message for responding to a comment
   */
  private buildCommentResponseMessage(task: AgentTask): string {
    const { trigger, context } = task;

    let message = `I'm responding to a comment in a document.\n\n`;

    if (context.documentContent) {
      message += `## Current Document\n\n${context.documentContent}\n\n`;
    }

    if (trigger.commentThread) {
      message += `## Comment Thread\n\n`;
      for (const comment of trigger.commentThread) {
        message += `**${comment.author}**: ${comment.text}\n`;
      }
      message += `\n`;
    }

    if (trigger.selectedText) {
      message += `## Selected/Highlighted Text\n\n"${trigger.selectedText}"\n\n`;
    }

    message += `## Request\n\n${trigger.mentionText}\n\n`;
    message += `Please respond to this comment. If the user is asking me to edit the document, I should make the edits using the appropriate tools. `;
    message += `By default, I should use track changes (suggestions) unless the user explicitly asks me to make direct edits.`;

    return message;
  }

  /**
   * Build message for document editing
   */
  private buildDocumentEditMessage(task: AgentTask): string {
    const { trigger, context } = task;

    let message = `I need to edit a document.\n\n`;

    if (context.documentContent) {
      message += `## Current Document\n\n${context.documentContent}\n\n`;
    }

    if (trigger.selectedText) {
      message += `## Selected Text\n\n"${trigger.selectedText}"\n\n`;
    }

    message += `## Edit Request\n\n${trigger.mentionText}\n\n`;
    message += `Please make the requested edits. Use track changes (suggestions) by default unless explicitly asked for direct edits.`;

    return message;
  }

  /**
   * Build message for inline @proof mention
   */
  private buildInlineMentionMessage(task: AgentTask): string {
    const { trigger, context } = task;

    let message = `The user mentioned @proof in the document.\n\n`;

    if (context.documentContent) {
      message += `## Document Content\n\n${context.documentContent}\n\n`;
    }

    if (trigger.surroundingText) {
      message += `## Context Around Mention\n\n${trigger.surroundingText}\n\n`;
    }

    message += `## User's Request\n\n${trigger.mentionText}\n\n`;
    message += `Please help with this request. If edits are needed, use track changes (suggestions) by default.`;

    return message;
  }
}

// ============================================================================
// Global Instance
// ============================================================================

let agentServiceInstance: AgentService | null = null;

export function getAgentService(): AgentService {
  if (!agentServiceInstance) {
    agentServiceInstance = new AgentService();
  }
  return agentServiceInstance;
}

export default AgentService;
