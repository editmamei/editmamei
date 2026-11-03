import { describe, it, expect } from 'vitest';
import { FEATURE_TOKEN_PATTERN } from '@editmamei/telemetry/feature-details.ts';
import {
  ACTION_OPERATIONS,
  DOM_OPERATIONS,
  SCRIPT_CAPABILITIES,
  SCRIPT_TOOL,
  callFeatures,
  scriptFeatures,
} from '@editmamei/telemetry/script-operations.ts';

const op = (name: string) => ({ kind: 'script_operation', tool: SCRIPT_TOOL, name });
const cap = (name: string) => ({ kind: 'script_capability', tool: SCRIPT_TOOL, name });
const unknown = (value: string) => ({
  kind: 'script_operation',
  tool: SCRIPT_TOOL,
  name: 'unknown',
  value,
});

describe('scriptFeatures: DOM calls', () => {
  it('names a listed method', () => {
    expect(scriptFeatures('app.activeDocument.resizeCanvas(100, 100);')).toEqual([
      op('resizeCanvas'),
    ]);
  });

  it('names trim, a Photoshop document method', () => {
    expect(scriptFeatures('doc.trim(TrimType.TOPLEFT);')).toEqual([op('trim')]);
  });

  it('counts each name once per script', () => {
    expect(scriptFeatures('d.flatten(); d.flatten(); d.flatten();')).toEqual([op('flatten')]);
  });

  it('sends an unlisted method as unknown, never by name', () => {
    expect(scriptFeatures('doc.exportForSmithWedding();')).toEqual([unknown('dom')]);
  });

  it('ignores language methods and descriptor plumbing', () => {
    const code = `
      var a = []; a.push(1); a.join(','); 'x'.toUpperCase(); Math.floor(1.5);
      var d = new ActionDescriptor(); d.putString(k, 'v'); d.getInteger(k); d.hasKey(k);
      app.documents.getByName('x'); new UnitValue(1, 'px').as('in');
    `;
    expect(scriptFeatures(code)).toEqual([]);
  });

  it('ignores functions and methods the script defines', () => {
    const code = `
      function helper(x) { return x; }
      var other = function () {};
      var o = { method: function () {} };
      o.method(); o.other(); helper(1); other();
    `;
    expect(scriptFeatures(code)).toEqual([]);
  });

  it("skips reads that aren't calls", () => {
    expect(scriptFeatures('var n = doc.layers.length; doc.activeLayer.opacity = 50;')).toEqual([]);
  });
});

describe('scriptFeatures: Action Manager calls', () => {
  it.each([
    ["executeAction(stringIDToTypeID('gaussianBlur'), d, DialogModes.NO);", 'gaussianBlur'],
    ["app.executeAction(app.stringIDToTypeID('gaussianBlur'), d);", 'gaussianBlur'],
    ["executeAction(charIDToTypeID('Mk  '), d);", 'Mk'],
    ["var idMk = charIDToTypeID('Mk  '); executeAction(idMk, d, DialogModes.NO);", 'Mk'],
  ])('reads %s', (code, name) => {
    expect(scriptFeatures(code)).toEqual([op(name)]);
  });

  it.each([
    "function sTID(s) { return app.stringIDToTypeID(s); } executeAction(sTID('align'), d);",
    "var sTID = function (s) { return stringIDToTypeID(s); }; executeAction(sTID('align'), d);",
    "var sTID = stringIDToTypeID; executeAction(sTID('align'), d);",
    "var sTID = app.stringIDToTypeID; var id = sTID('align'); executeAction(id, d);",
    "executeAction(sTID('align'), d); function sTID(s) { return stringIDToTypeID(s); }",
  ])('follows the alias in %s', (code) => {
    expect(scriptFeatures(code)).toEqual([op('align')]);
  });

  it('sends an unlisted id as unknown', () => {
    expect(scriptFeatures("executeAction(stringIDToTypeID('smithWedding'), d);")).toEqual([
      unknown('action'),
    ]);
  });

  it("counts an id it can't read as dynamic", () => {
    expect(scriptFeatures("executeAction(stringIDToTypeID('ga' + 'ussianBlur'), d);")).toEqual([
      unknown('dynamic'),
    ]);
    expect(scriptFeatures('executeAction(pickEvent(), d);')).toEqual([unknown('dynamic')]);
  });

  it('normalizes a listed id with spaces', () => {
    expect(
      scriptFeatures("executeAction(stringIDToTypeID('Adobe Camera Raw Filter'), d);")
    ).toEqual([op('Adobe_Camera_Raw_Filter')]);
  });
});

describe('scriptFeatures: capabilities and dynamic code', () => {
  it.each([
    ["new File('x');", 'File'],
    ["File.saveDialog('x');", 'File'],
    ["new Folder('x');", 'Folder'],
    ['new Socket();', 'Socket'],
    ["app.system('ls');", 'app.system'],
    ["$.evalFile('lib.jsx');", '$.evalFile'],
    ['new BridgeTalk();', 'BridgeTalk'],
  ])('flags %s', (code, name) => {
    expect(scriptFeatures(code)).toContainEqual(cap(name));
  });

  it('counts eval and computed calls as dynamic', () => {
    expect(scriptFeatures("eval('x');")).toEqual(
      expect.arrayContaining([cap('eval'), unknown('dynamic')])
    );
    expect(scriptFeatures('handlers[kind](doc);')).toEqual([unknown('dynamic')]);
  });

  it('counts an oversized script as dynamic without scanning it', () => {
    expect(scriptFeatures(`doc.flatten();${' '.repeat(300_000)}`)).toEqual([unknown('dynamic')]);
  });

  it.each([undefined, null, 42, {}])('returns nothing for a non-string (%j)', (code) => {
    expect(scriptFeatures(code)).toEqual([]);
  });
});

describe('scriptFeatures: nothing in a script leaves it', () => {
  const SECRETS = [
    'Smith',
    'Wedding',
    'wedding',
    'alice',
    'Users',
    'psd',
    'Happy',
    'Birthday',
    'Acme',
    'secretHelper',
    'clientName',
    'evilMethod',
    'hunter2',
  ];

  const HOSTILE = [
    // Paths, client names and on-image text in every position a string can sit.
    `var doc = app.open(new File('C:/Users/alice/Smith Wedding.psd'));
     doc.artLayers.getByName('Acme logo').visible = false;
     var t = doc.artLayers.add(); t.textItem.contents = 'Happy Birthday Alice';
     doc.saveAs(new File('/Users/alice/Smith_Wedding.psd'));`,
    // A user's words shaped like an action id or a member call.
    `executeAction(stringIDToTypeID('Smith Wedding'), d);
     executeAction(charIDToTypeID('Acme'), d);
     var clientName = stringIDToTypeID('Happy Birthday'); executeAction(clientName, d);`,
    // Helpers and properties named after people or projects.
    `function secretHelper() {} secretHelper(); doc.evilMethod(); doc.SmithWedding('x');
     clientName.hunter2('Acme');`,
    // Text inside comments and regular expressions.
    `// Smith Wedding for Acme
     /* alice hunter2 */ var r = /Smith Wedding/.test(x); doc.flatten();`,
    // Strings that try to break out of the scanner.
    `var s = 'Smith\\'s Wedding'; var u = "alice \\" hunter2"; doc.flatten();`,
    // An unterminated string and an unterminated comment.
    `doc.flatten(); var s = 'Smith Wedding`,
    `doc.flatten(); /* Smith Wedding`,
  ];

  it.each(HOSTILE)('sends no private word from: %s', (code) => {
    const sent = JSON.stringify(callFeatures(SCRIPT_TOOL, undefined, { code }, null));
    for (const word of SECRETS) expect(sent).not.toContain(word);
  });

  it('sends only listed names or the catch-all, for anything', () => {
    const allowed = new Set([...DOM_OPERATIONS, ...ACTION_OPERATIONS, ...SCRIPT_CAPABILITIES]);
    const normalized = new Set([...allowed].map((n) => n.replace(/ /g, '_')));
    for (const code of HOSTILE) {
      for (const feature of scriptFeatures(code)) {
        if (feature.name === 'unknown') {
          expect(['dom', 'action', 'dynamic']).toContain(feature.value);
        } else {
          expect(normalized.has(feature.name)).toBe(true);
          expect(feature.value).toBeUndefined();
        }
      }
    }
  });

  it('keeps every listed name inside the server token shape', () => {
    for (const list of [DOM_OPERATIONS, ACTION_OPERATIONS, SCRIPT_CAPABILITIES]) {
      for (const name of list) expect(name.replace(/ /g, '_')).toMatch(FEATURE_TOKEN_PATTERN);
    }
  });
});

describe('scriptFeatures: odd input', () => {
  it('stays fast on pathological input', () => {
    const inputs = [
      '/'.repeat(200_000),
      "'".repeat(200_000),
      '('.repeat(200_000),
      '\\'.repeat(200_000),
    ];
    const started = Date.now();
    for (const code of inputs) scriptFeatures(code);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('hands unlisted names to a local callback, and only there', () => {
    const seen: string[] = [];
    const features = scriptFeatures('doc.SmithWedding();', (name) => seen.push(name));
    expect(seen).toEqual(['SmithWedding']);
    expect(JSON.stringify(features)).not.toContain('Smith');
  });
});

describe('callFeatures', () => {
  it('leaves other tools at their option values', () => {
    expect(callFeatures('ps_filter', {}, { code: 'doc.flatten();' }, null)).toEqual([]);
  });

  it('adds what came before a script', () => {
    expect(
      callFeatures(SCRIPT_TOOL, {}, { code: '' }, { tool: 'ps_layer_mask', success: false })
    ).toEqual([{ kind: 'script_before', tool: 'ps_layer_mask', name: 'failure' }]);
  });

  it('picks up the reason as an ordinary option value', () => {
    const schema = { properties: { reason: { enum: ['no_tool_for_this', 'other'] } } };
    expect(
      callFeatures(SCRIPT_TOOL, schema, { code: '', reason: 'no_tool_for_this' }, null)
    ).toEqual([{ kind: 'option', tool: SCRIPT_TOOL, name: 'reason', value: 'no_tool_for_this' }]);
  });
});
