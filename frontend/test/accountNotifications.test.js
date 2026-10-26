import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
let channel;
beforeEach(() => {
    vi.resetModules();localStorage.clear();
    vi.stubGlobal('BroadcastChannel', class {
        constructor() { channel=this; }
        postMessage=vi.fn();
        close=vi.fn();
    });
});
afterEach(()=>vi.unstubAllGlobals());
describe('account hints invalidate documents without changing server sessions',()=>{
    it('ignores same-account validation and stale logout from another account',async()=>{
        const state=await import('../js/util/authAccountState.js');
        const changed=vi.fn();const stop=state.watchAccountChanges(changed);
        state.acceptAccount({id:'b'});
        channel.onmessage({data:{kind:'login',account:'b'}});
        channel.onmessage({data:{kind:'logout',account:'a'}});
        expect(changed).not.toHaveBeenCalled();
        const before=state.accountRevision();
        channel.onmessage({data:{kind:'login',account:'a'}});
        expect(changed).toHaveBeenCalledTimes(1);
        expect(state.accountRevision()).toBeGreaterThan(before);
        expect(localStorage.getItem('mw-auth-user')).toBe('b');
        stop();
    });
    it('works with storage notifications when BroadcastChannel is unavailable',async()=>{
        vi.stubGlobal('BroadcastChannel',undefined);
        const state=await import('../js/util/authAccountState.js');
        const changed=vi.fn();const stop=state.watchAccountChanges(changed);
        state.acceptAccount({id:'a'});
        window.dispatchEvent(new StorageEvent('storage',{key:'mw-auth-user',oldValue:'a',newValue:'b'}));
        expect(changed).toHaveBeenCalledTimes(1);
        stop();
        window.dispatchEvent(new StorageEvent('storage',{key:'mw-auth-user',oldValue:'b',newValue:'a'}));
        expect(changed).toHaveBeenCalledTimes(1);
    });
    it('publishes logout only after explicit local invalidation without relying on storage',async()=>{
        const state=await import('../js/util/authAccountState.js');
        const stop=state.watchAccountChanges(vi.fn());
        state.acceptAccount({id:'a'});
        const revision=state.accountRevision();
        const failure=vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw Error('denied')});
        state.leaveAccount();
        expect(state.accountRevision()).toBeGreaterThan(revision);
        expect(channel.postMessage).toHaveBeenLastCalledWith({kind:'logout',account:'a'});
        failure.mockRestore();stop();
    });
});
