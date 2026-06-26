// src/services/anthropic.ts
// Wrapper Anthropic Claude SDK
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let _client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (_client) return _client;
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY não configurada');
  }
  _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return _client;
}

export function isConfigured(): boolean {
  return !!config.ANTHROPIC_API_KEY;
}
