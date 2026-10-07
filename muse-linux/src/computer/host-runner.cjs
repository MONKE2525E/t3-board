'use strict';
const { spawn } = require('node:child_process');
const { ProcessOwner } = require('./session/runner.cjs');

// This runner deliberately borrows the real desktop's explicitly supplied bus.
// Only the persistent helper is launchable; model arguments never reach spawn.
class HostRunner {
  constructor({ helper, environment, clock, allowed }) {
    this.helper = helper; this.environment = Object.freeze({ ...environment });
    this.clock = clock; this.allowed = allowed; this.owner = new ProcessOwner();
    this.children = new Set();
  }
  async spawn(id, argv, options) {
    if (id !== 'accessibility-worker' || argv.length || !this.allowed() || options.signal.aborted) throw Error('worker_permission_denied');
    const child = spawn(this.helper, [], { env: this.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const group = this.owner.add(child); this.children.add(group);
    child.terminate = async () => { const ok = await this.owner.stop(group, 800); this.children.delete(group); return { stopped: ok }; };
    child.on('close', () => this.children.delete(group));
    return child;
  }
  async stop() { return Promise.all([...this.children].map(group => this.owner.stop(group, 800))); }
  stopSync() {
    for (const group of this.children) if (this.owner.refresh(group)) {
      try { process.kill(-group.leader.groupId, 'SIGKILL'); } catch { /* Only owned helper groups. */ }
    }
  }
}
module.exports = { HostRunner };
