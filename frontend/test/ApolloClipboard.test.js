import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloClipboard } from '../js/stream/ApolloClipboard.js';
describe('Apollo clipboard channel', () => {
    let c, send, pending, error, writeText, readText, focused;
    beforeEach(() => {
        vi.useFakeTimers();
        focused = true;
        send = vi.fn();
        pending = vi.fn();
        error = vi.fn();
        writeText = vi.fn().mockResolvedValue();
        readText = vi.fn().mockResolvedValue('Mac é🌙\nclipboard');
        vi.stubGlobal('navigator', { clipboard: { writeText, readText } });
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
    it('reports a remote size refusal explicitly', () => {
        c.handle({ type: 'clipboarderror', code: 'too_large' });
        expect(error).toHaveBeenCalledWith('tooLarge');
    });
    it('honors independent permissions', async () => {
        c.handle({ type: 'clipboardcaps', read: false, write: false });
        send.mockClear();
        await c.paste('x');
        await vi.advanceTimersByTimeAsync(5000);
        expect(send).not.toHaveBeenCalled();
    });
    it('reads the client text before sending exactly one paste', async () => {
        send.mockClear();
        await c.pasteFromClient();
        expect(readText).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(1);
        const chunk = send.mock.calls[0][0];
        expect(chunk.type).toBe('clipboardchunk');
        expect(
            new TextDecoder().decode(Uint8Array.from(atob(chunk.data), (x) => x.charCodeAt(0))),
        ).toBe('Mac é🌙\nclipboard');
    });
    it.each(['refused', 'empty', 'missing'])(
        'never pastes stale remote text when local read is %s',
        async (reason) => {
            if (reason === 'refused') readText.mockRejectedValue(new Error('NotAllowed'));
            if (reason === 'empty') readText.mockResolvedValue('');
            if (reason === 'missing') navigator.clipboard.readText = undefined;
            send.mockClear();
            await c.pasteFromClient();
            expect(send).not.toHaveBeenCalled();
            expect(error).toHaveBeenCalledWith(reason === 'empty' ? 'textOnly' : 'readDenied');
        },
    );
    it.each(['destroy', 'cancel', 'blur', 'permission'])(
        'ignores a late local read after %s',
        async (action) => {
            let resolve;
            readText.mockImplementation(
                () =>
                    new Promise((r) => {
                        resolve = r;
                    }),
            );
            send.mockClear();
            const reading = c.pasteFromClient();
            if (action === 'destroy') c.destroy();
            if (action === 'cancel') c.cancelLocalRead();
            if (action === 'blur') focused = false;
            if (action === 'permission') c.write = false;
            resolve('private text');
            await reading;
            expect(send).not.toHaveBeenCalled();
        },
    );
    it('bounds permission waits and rejects concurrent reads without uploading later', async () => {
        let resolve;
        readText.mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        send.mockClear();
        const reading = c.pasteFromClient();
        await c.pasteFromClient();
        expect(error).toHaveBeenCalledWith('busy');
        expect(readText).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(10000);
        await reading;
        expect(error).toHaveBeenCalledWith('readDenied');
        resolve('too late');
        await Promise.resolve();
        expect(send.mock.calls.filter(([m]) => m.type === 'clipboardchunk')).toEqual([]);
    });
    it('does not replace the client clipboard with remote data while reading it', async () => {
        let resolve;
        readText.mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        const reading = c.pasteFromClient();
        c.handle({
            type: 'clipboardchunk',
            id: 'old',
            index: 0,
            total: 1,
            data: btoa('old remote'),
        });
        await c.copyPending();
        expect(writeText).not.toHaveBeenCalled();
        resolve('new client');
        await reading;
        expect(c.text).toBe(null);
    });
    it('lets a native paste supersede an older asynchronous local read', async () => {
        let resolve;
        readText.mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        const reading = c.pasteFromClient();
        send.mockClear();
        await c.paste('new native paste');
        resolve('stale permission result');
        await reading;
        expect(send).toHaveBeenCalledTimes(1);
        expect(atob(send.mock.calls[0][0].data)).toBe('new native paste');
    });
    it('does not ask to read the client clipboard without write permission', async () => {
        c.write = false;
        await c.pasteFromClient();
        expect(readText).not.toHaveBeenCalled();
    });
});
