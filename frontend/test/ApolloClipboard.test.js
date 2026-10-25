import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloClipboard } from '../js/stream/ApolloClipboard.js';
describe('Apollo clipboard channel', () => {
    let c, send, pending, error, writeText, focused;
    beforeEach(() => {
        vi.useFakeTimers();
        focused = true;
        send = vi.fn();
        pending = vi.fn();
        error = vi.fn();
        writeText = vi.fn().mockResolvedValue();
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        c = new ApolloClipboard({ send, pending, error, foreground: () => focused });
        c.handle({ type: 'clipboardcaps', read: true, write: true });
    });
    afterEach(() => {
        c.destroy();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });
    it('polls only in the foreground and stops on disposal', async () => {
        expect(send).toHaveBeenCalledTimes(1);
        focused = false;
        await vi.advanceTimersByTimeAsync(5000);
        expect(send).toHaveBeenCalledTimes(1);
        focused = true;
        await vi.advanceTimersByTimeAsync(1000);
        expect(send).toHaveBeenCalledTimes(2);
        c.destroy();
        await vi.advanceTimersByTimeAsync(5000);
        expect(send).toHaveBeenCalledTimes(2);
    });
    it('round trips Unicode across bounded chunks', async () => {
        send.mockClear();
        const text = 'é🌙\n'.repeat(5000);
        const paste = c.paste(text);
        await vi.advanceTimersByTimeAsync(100);
        await paste;
        for (const [chunk] of send.mock.calls) {
            expect(JSON.stringify(chunk).length).toBeLessThan(8192);
            c.handle(chunk);
        }
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith(text);
    });
    it('keeps text after a browser refusal and handles empty text', async () => {
        writeText.mockRejectedValueOnce(new Error('NotAllowed'));
        c.handle({ type: 'clipboardchunk', id: 'x', index: 0, total: 1, data: btoa('hello') });
        await Promise.resolve();
        expect(c.text).toBe('hello');
        await c.copyPending();
        expect(c.text).toBe(null);
        c.handle({ type: 'clipboardchunk', id: 'y', index: 0, total: 1, data: '' });
        await Promise.resolve();
        expect(writeText).toHaveBeenLastCalledWith('');
    });
    it('does not write in background or after disposal', async () => {
        focused = false;
        c.handle({ type: 'clipboardchunk', id: 'x', index: 0, total: 1, data: btoa('private') });
        expect(writeText).not.toHaveBeenCalled();
        c.destroy();
        focused = true;
        await c.copyPending();
        expect(writeText).not.toHaveBeenCalled();
    });
    it('rejects oversized pastes without truncating', async () => {
        send.mockClear();
        await c.paste('🌙'.repeat(70000));
        expect(send).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith('tooLarge');
    });
    it('rejects out-of-order and malformed chunks', () => {
        for (const msg of [
            { index: 1, total: 2, data: btoa('x') },
            { index: 0, total: 65, data: '' },
            { index: 0, total: 1, data: '!' },
            { index: 0, total: 1, data: btoa('x'.repeat(4097)) },
        ])
            c.handle({ type: 'clipboardchunk', id: 'x', ...msg });
        expect(writeText).not.toHaveBeenCalled();
    });
    it('honors independent permissions', async () => {
        c.handle({ type: 'clipboardcaps', read: false, write: false });
        send.mockClear();
        await c.paste('x');
        await vi.advanceTimersByTimeAsync(5000);
        expect(send).not.toHaveBeenCalled();
    });
});
