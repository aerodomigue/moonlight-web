const MAX_BYTES = 256 * 1024;
const CHUNK_BYTES = 4096;
const encoder = new TextEncoder();

// Data stays in this stream's memory and authenticated input channel.
export class ApolloClipboard {
    constructor({
        send,
        pending,
        error,
        foreground = () => !document.hidden && document.hasFocus(),
    }) {
        Object.assign(this, { send, pending, error, foreground });
        this.read = false;
        this.write = false;
        this.closed = false;
        this.text = null;
        this.assembly = null;
        this.pasting = false;
        this.timer = null;
    }
    handle(msg) {
        if (this.closed) return;
        if (msg.type === 'clipboardcaps') {
            this.read = msg.read === true;
            this.write = msg.write === true;
            clearTimeout(this.timer);
            this.poll();
        } else if (msg.type === 'clipboarderror') {
            this.error(
                msg.code === 'too_large' ? 'tooLarge' : msg.code === 'busy' ? 'busy' : 'failed',
            );
        } else if (msg.type === 'clipboardchunk' && this.read) {
            const { id, index, total, data } = msg;
            if (
                typeof id !== 'string' ||
                id.length > 64 ||
                !Number.isInteger(index) ||
                !Number.isInteger(total) ||
                total < 1 ||
                total > MAX_BYTES / CHUNK_BYTES ||
                index < 0 ||
                index >= total ||
                typeof data !== 'string' ||
                data.length > 5464
            ) {
                this.assembly = null;
                return;
            }
            if (index === 0) this.assembly = { id, total, chunks: [], start: performance.now() };
            const a = this.assembly;
            if (
                !a ||
                a.id !== id ||
                a.total !== total ||
                a.chunks.length !== index ||
                performance.now() - a.start > 10000
            ) {
                this.assembly = null;
                return;
            }
            try {
                const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
                if (bytes.length > CHUNK_BYTES) throw new Error('Chunk too large');
                a.chunks.push(bytes);
                if (a.chunks.length !== total) return;
                this.assembly = null;
                const buffer = new Uint8Array(a.chunks.reduce((n, c) => n + c.length, 0));
                let offset = 0;
                for (const c of a.chunks) {
                    buffer.set(c, offset);
                    offset += c.length;
                }
                this.text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
                this.pending(true);
                this.copyPending();
            } catch (_) {
                this.assembly = null;
            }
        }
    }
    poll() {
        if (this.closed || !this.read) return;
        if (this.foreground()) this.send({ type: 'clipboardread' });
        this.timer = setTimeout(() => this.poll(), 1000);
    }
    async copyPending() {
        if (this.closed || this.text === null || !this.foreground()) return;
        const text = this.text;
        try {
            await navigator.clipboard.writeText(text);
            if (!this.closed && this.text === text) {
                this.text = null;
                this.pending(false);
            }
        } catch (_) {
            /* Keep the text pending for the next existing user gesture. */
        }
    }
    async paste(text) {
        if (this.closed || !this.write) return;
        if (this.pasting) {
            this.error('busy');
            return;
        }
        const bytes = encoder.encode(text);
        if (bytes.length > MAX_BYTES) {
            this.error('tooLarge');
            return;
        }
        this.pasting = true;
        this.text = null;
        this.pending(false);
        const id = crypto.randomUUID();
        const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
        try {
            for (let index = 0; index < total && !this.closed; index++) {
                const chunk = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
                this.send({
                    type: 'clipboardchunk',
                    id,
                    index,
                    total,
                    data: btoa(String.fromCharCode(...chunk)),
                });
                if (index + 1 < total) await new Promise((resolve) => setTimeout(resolve, 0));
            }
        } finally {
            this.pasting = false;
        }
    }
    destroy() {
        this.closed = true;
        clearTimeout(this.timer);
        this.text = null;
        this.assembly = null;
        this.pending(false);
    }
}
