import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { skillsCommand } from '../src/commands/skills.js';
import { createSkill } from '../src/skills.js';
import { captureRun, withTempCwd, stripAnsi } from './support.js';

describe('skillsCommand', () => {
  it('lists project skills as JSON', async () => {
    await withTempCwd(async () => {
      createSkill('repo', { scope: 'project' });
      const { output } = await captureRun(() => skillsCommand('list', undefined, { json: true }));
      const entries = JSON.parse(output);
      assert.ok(Array.isArray(entries));
      assert.ok(entries.some((e: { path: string; scope: string }) => e.scope === 'project' && e.path.includes('repo')));
    });
  });

  it('shows a skill as JSON', async () => {
    await withTempCwd(async () => {
      createSkill('repo', { scope: 'project' });
      const { output } = await captureRun(() => skillsCommand('show', 'repo', { json: true }));
      const skill = JSON.parse(output);
      assert.ok(skill.filePath.includes('repo'));
      assert.equal(skill.scope, 'project');
    });
  });

  it('checks skills as JSON', async () => {
    await withTempCwd(async () => {
      createSkill('repo', { scope: 'project' });
      const { output } = await captureRun(() => skillsCommand('check', undefined, { json: true }));
      const result = JSON.parse(output);
      assert.ok(typeof result.ok === 'boolean');
      assert.ok(typeof result.checked === 'number');
    });
  });

  it('exits 1 when show is called without a name', async () => {
    await withTempCwd(async () => {
      const { exitCode, output } = await captureRun(() => skillsCommand('show', undefined, {}));
      assert.equal(exitCode, 1);
      assert.ok(stripAnsi(output).includes('Usage'));
    });
  });

  it('exits 1 when showing a skill that does not exist', async () => {
    await withTempCwd(async () => {
      const { exitCode } = await captureRun(() => skillsCommand('show', 'nope', { json: true }));
      assert.equal(exitCode, 1);
    });
  });

  it('exits 1 and warns on an unknown action', async () => {
    await withTempCwd(async () => {
      const { exitCode, output } = await captureRun(() => skillsCommand('frobnicate', undefined, {}));
      assert.equal(exitCode, 1);
      assert.ok(stripAnsi(output).includes('Unknown skills action'));
    });
  });
});
