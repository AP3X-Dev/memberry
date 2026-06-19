import { describe, it, expect, vi } from 'vitest';
import { resolvePort } from '../config/port.js';

describe('resolvePort', () => {
  it('defaults to 3101 when nothing is set', () => {
    expect(resolvePort({})).toBe(3101);
  });

  it('coalesces empty strings — the systemd EnvironmentFile PORT= case (was NaN→random port)', () => {
    expect(resolvePort({ PORT: '', MCP_PORT: '' })).toBe(3101);
    expect(resolvePort({ PORT: '', MCP_PORT: '3101' })).toBe(3101);
  });

  it('prefers PORT over MCP_PORT — one precedence shared by server and readyz-check', () => {
    expect(resolvePort({ PORT: '8080', MCP_PORT: '3101' })).toBe(8080);
  });

  it('falls back to MCP_PORT when PORT is unset or empty', () => {
    expect(resolvePort({ MCP_PORT: '3200' })).toBe(3200);
    expect(resolvePort({ PORT: '', MCP_PORT: '3200' })).toBe(3200);
  });

  it('rejects non-numeric / out-of-range values and warns, falling back to 3101', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolvePort({ PORT: 'abc' })).toBe(3101);
    expect(resolvePort({ PORT: '0' })).toBe(3101);
    expect(resolvePort({ PORT: '70000' })).toBe(3101);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('honors a custom fallback', () => {
    expect(resolvePort({}, 8000)).toBe(8000);
  });

  it('trims surrounding whitespace', () => {
    expect(resolvePort({ PORT: ' 3300 ' })).toBe(3300);
  });
});
