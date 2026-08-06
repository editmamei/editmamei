import { describe, it, expect } from 'vitest';
import { FACE_MENU_TARGETS } from '@editmamei/tools/scene-tools.ts';
import { FACE_FEATURE_TARGETS } from '@editmamei/perception/select-recipes.ts';

/**
 * The derived-list invariant: any list that
 * mirrors another table must be generated from it or pinned by a sync test.
 *
 * `FACE_MENU_TARGETS` (scene-tools) is what ps_read_scene ADVERTISES as
 * on-demand face regions. `FACE_FEATURE_TARGETS` (select-recipes) is what
 * ps_select_by_reference actually ACCEPTS. Since 2026-08-01 the mesh no longer
 * runs during the scene read, so the menu is a promise made ahead of any
 * verification — if it names a target the resolver rejects, the agent gets
 * "Unknown select-by-reference target" for a region the menu told it to use, and
 * nothing else would catch it (the menu entries are built without touching PS).
 */
describe('face-feature menu mirrors the resolver targets', () => {
  it('every advertised menu target is a target the resolver accepts', () => {
    const accepted = new Set<string>(FACE_FEATURE_TARGETS);
    const notAccepted = FACE_MENU_TARGETS.filter((t) => !accepted.has(t));
    expect(notAccepted).toEqual([]);
  });

  it('advertises the full resolver set — a new feature must not be silently unlisted', () => {
    expect([...FACE_MENU_TARGETS].sort()).toEqual([...FACE_FEATURE_TARGETS].sort());
  });

  it('does NOT advertise face_face — the core precompute already saves scene:face', () => {
    // A mesh `face_face` produced a duplicate full-resolution channel that
    // ps_select_by_reference could never load (observed live 2026-07-30).
    expect(FACE_MENU_TARGETS as readonly string[]).not.toContain('face_face');
    expect(FACE_FEATURE_TARGETS as readonly string[]).not.toContain('face_face');
  });
});
