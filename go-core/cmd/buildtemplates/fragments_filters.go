package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// applyGaussianBlur skeleton. Slots: 1=prologue (composed by
		// filterPrologue, which declares `wasRasterized` for the result below),
		// 2=radius, 3=radius.
		vault.GBlur: `
    %s

    layer.applyGaussianBlur(%s);

    var result = {
      applied: true,
      filter: 'Gaussian Blur',
      radius: %s,
      wasRasterized: wasRasterized,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
    return result;
  `,

		// applyUnsharpMask. Slots: 1=prologue, 2=amount, 3=radius,
		// 4=threshold (call), 5=amount, 6=radius, 7=threshold (result).
		vault.USharp: `
    %s

    layer.applyUnSharpMask(%s, %s, %s);

    return {
      applied: true,
      filter: 'Unsharp Mask',
      amount: %s,
      radius: %s,
      threshold: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applyAddNoise. Slots: 1=helper, 2=dup, 3=distribution(raw enum),
		// 4=amount, 5=monochromatic (call), 6=amount, 7=distribution(jsLit),
		// 8=monochromatic (result).
		vault.ANoise: `
    %s

    var distEnum = NoiseDistribution.%s;
    layer.applyAddNoise(%s, distEnum, %s);

    return {
      applied: true,
      filter: 'Add Noise',
      amount: %s,
      distribution: %s,
      monochromatic: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applyMotionBlur. Slots: 1=helper, 2=dup, 3=angle, 4=radius (call),
		// 5=angle, 6=radius (result).
		vault.MBlur: `
    %s

    layer.applyMotionBlur(%s, %s);

    return {
      applied: true,
      filter: 'Motion Blur',
      angle: %s,
      radius: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applyLensBlur (AM Bokh). Slots: 1=getMinimalContextInfo, 2=helperFunctions,
		// 3=duplicateForOp, 4=focalDistance, 5=invertDepth(bool literal),
		// 6=irisShapeCharID(raw), 7=radius, 8=irisBladeCurvature, 9=irisRotation,
		// 10=specularBrightness, 11=specularThreshold, 12=noiseAmount,
		// 13=noiseDistCharID(raw), 14=noiseMonochromatic(bool literal),
		// 15=radius, 16=irisShape(jsLit), 17=irisBladeCurvature, 18=irisRotation,
		// 19=specularBrightness, 20=specularThreshold, 21=noiseAmount,
		// 22=noiseDistribution(jsLit), 23=noiseMonochromatic(bool literal),
		// 24=depthSource(jsLit), 25=focalDistance, 26=invertDepth(bool literal).
		vault.LensBlur: `
    %s

    // Verified against ScriptListener UI ground truth — 2026-06-03 AM
    // Descriptor Audit STEP 22, spec at src/spec/ps27/filters/lens-
    // blur.ts. The pre-audit emission was forum-lore CS6 fiction — wrong
    // event ID (stringID 'lensBlur' instead of charID 'Bokh'), wrong
    // descriptor keys (stringID 'radius' / 'irisShape' / etc. instead
    // of charID Bk* family), wrong enum values (string polygon names
    // instead of BeS3..BeS8). HIGH-severity silent-no-op pattern — the
    // same class of bug recurred across several filters. Descriptor key
    // order matches the capture exactly.
    var lbDesc = new ActionDescriptor();

    // Depth source group (1-4 in capture order). Capture only confirms
    // the default-depth-map values BeIt + BeCm — alternate depth modes
    // are unverified and currently fall back to the safe default.
    lbDesc.putEnumerated(cTID('BkDi'), cTID('BtDi'), cTID('BeIt'));
    lbDesc.putEnumerated(cTID('BkDc'), cTID('BtDc'), cTID('BeCm'));
    lbDesc.putInteger(cTID('BkDp'), %s);
    lbDesc.putBoolean(cTID('BkDs'), %s);

    // Iris group (5-8). BkIb (radius) is putDouble — pre-audit used
    // putInteger.
    lbDesc.putEnumerated(cTID('BkIs'), cTID('BtIs'), cTID('%s'));
    lbDesc.putDouble(cTID('BkIb'), %s);
    lbDesc.putInteger(cTID('BkIc'), %s);
    lbDesc.putInteger(cTID('BkIr'), %s);

    // Specular group (9-10). BkSb (brightness) is putDouble.
    lbDesc.putDouble(cTID('BkSb'), %s);
    lbDesc.putInteger(cTID('BkSt'), %s);

    // Noise group (11-13).
    lbDesc.putInteger(cTID('BkNa'), %s);
    lbDesc.putEnumerated(cTID('BkNt'), cTID('BtNt'), cTID('%s'));
    lbDesc.putBoolean(cTID('BkNm'), %s);

    executeAction(cTID('Bokh'), lbDesc, DialogModes.NO);

    return {
      applied: true,
      filter: 'Lens Blur',
      radius: %s,
      iris_shape: %s,
      iris_blade_curvature: %s,
      iris_rotation: %s,
      specular_brightness: %s,
      specular_threshold: %s,
      noise_amount: %s,
      noise_distribution: %s,
      noise_monochromatic: %s,
      depth_source: %s,
      focal_distance: %s,
      invert_depth: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applySmartSharpen. Slots: 1=getMinimalContextInfo, 2=helperFunctions,
		// 3=duplicateForOp, 4=amount, 5=radius, 6=noiseReduction,
		// 7=blurEnumCharID(raw), 8=motionAngleLine(or empty), 9=shadowFade,
		// 10=shadowTonalWidth, 11=shadowRadius, 12=highlightFade,
		// 13=highlightTonalWidth, 14=highlightRadius, 15=amount, 16=radius,
		// 17=noiseReduction, 18=removeMode(jsLit), 19=motionAngle, 20=shadowFade,
		// 21=shadowTonalWidth, 22=shadowRadius, 23=highlightFade,
		// 24=highlightTonalWidth, 25=highlightRadius. The 0%% in the comment is
		// an escaped literal.
		vault.SmartShrp: `
    %s

    // Verified against ScriptListener UI ground truth — 2026-06-03 AM
    // Descriptor Audit STEP 23, spec at src/spec/ps27/filters/smart-
    // sharpen.ts. Pre-audit emission had multiple drifts (HIGH):
    //   - sub-object class typeID was misspelled (extra "ive" infix)
    //     — PS recognises only adaptCorrectTones. Same typo pattern
    //     found in applyShadowsHighlights.
    //     The entire shadows/highlights tab silently fell back to 0%%.
    //   - Root Amnt + noiseReduction were putInteger; PS UI emits both
    //     as putUnitDouble percentUnit. Pre-audit values may have
    //     silently default-fallen back.
    //   - Sub-object outer keys were stringIDs 'shadowMode'/'highlightMode';
    //     PS emits charIDs 'sdwM'/'hglM'.
    //   - Inner Amnt/Wdth were putInteger; PS emits putUnitDouble #Prc.
    //     Inner Rds  stays putInteger.
    //   - blur enum-value was stringID; PS emits charID 'GsnB' (et al).
    var ssDesc = new ActionDescriptor();
    ssDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
    ssDesc.putBoolean(sTID('useLegacy'), false);
    ssDesc.putUnitDouble(cTID('Amnt'), cTID('#Prc'), %s);
    ssDesc.putUnitDouble(cTID('Rds '), cTID('#Pxl'), %s);
    ssDesc.putUnitDouble(sTID('noiseReduction'), cTID('#Prc'), %s);
    ssDesc.putEnumerated(cTID('blur'), sTID('blurType'), cTID('%s'));
    %s

    // Shadows tab — adaptCorrectTones sub-descriptor (NO "ive"). Outer
    // key sdwM is charID. Amnt/Wdth are putUnitDouble #Prc; Rds is
    // putInteger.
    var shDesc = new ActionDescriptor();
    shDesc.putUnitDouble(cTID('Amnt'), cTID('#Prc'), %s);
    shDesc.putUnitDouble(cTID('Wdth'), cTID('#Prc'), %s);
    shDesc.putInteger(cTID('Rds '), %s);
    ssDesc.putObject(cTID('sdwM'), sTID('adaptCorrectTones'), shDesc);

    // Highlights tab — same sub-descriptor shape. Outer key hglM is
    // charID.
    var hlDesc = new ActionDescriptor();
    hlDesc.putUnitDouble(cTID('Amnt'), cTID('#Prc'), %s);
    hlDesc.putUnitDouble(cTID('Wdth'), cTID('#Prc'), %s);
    hlDesc.putInteger(cTID('Rds '), %s);
    ssDesc.putObject(cTID('hglM'), sTID('adaptCorrectTones'), hlDesc);

    executeAction(sTID('smartSharpen'), ssDesc, DialogModes.NO);

    return {
      applied: true,
      filter: 'Smart Sharpen',
      amount: %s,
      radius: %s,
      noise_reduction: %s,
      remove_mode: %s,
      motion_angle: %s,
      shadow_fade: %s,
      shadow_tonal_width: %s,
      shadow_radius: %s,
      highlight_fade: %s,
      highlight_tonal_width: %s,
      highlight_radius: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applyReduceNoise. Slots: 1=getMinimalContextInfo, 2=helperFunctions,
		// 3=duplicateForOp, 4=strength, 5=preserveDetails, 6=perChannel block
		// (or empty), 7=colorNoise, 8=sharpenDetails, 9=removeJpegArtifact(bool),
		// 10=strength, 11=preserveDetails, 12=colorNoise, 13=sharpenDetails,
		// 14=removeJpegArtifact(bool), 15=perChannel(bool literal).
		vault.RedNoise: `
    %s

    var rnDesc = new ActionDescriptor();

    // Build the channelDenoise list. The COMPOSITE entry is always
    // present — it carries the primary luminance-noise-reduction
    // (strength + preserveDetails) controls that pre-hotfix-5 lived at
    // the descriptor root. Per-channel RGB entries are appended when
    // perChannel=true.
    var chList = new ActionList();

    // Composite channel — always present.
    var compDesc = new ActionDescriptor();
    var compRef = new ActionReference();
    compRef.putEnumerated(sTID('channel'), sTID('channel'), sTID('composite'));
    compDesc.putReference(sTID('channel'), compRef);
    compDesc.putInteger(sTID('amount'), %s);
    compDesc.putInteger(sTID('edgeFidelity'), %s);
    chList.putObject(sTID('channelDenoiseParams'), compDesc);

    %s

    rnDesc.putList(sTID('channelDenoise'), chList);

    // Root-level keys — unitDouble percentUnit for colorNoise + sharpen,
    // boolean for removeJPEGArtifact (capital JPEG).
    rnDesc.putUnitDouble(sTID('colorNoise'), sTID('percentUnit'), %s);
    rnDesc.putUnitDouble(sTID('sharpen'), sTID('percentUnit'), %s);
    rnDesc.putBoolean(sTID('removeJPEGArtifact'), %s);

    // PS dialog tags every invocation with a preset string. "Default"
    // is what PS emits when the user opens the dialog and clicks OK
    // without picking a saved preset. Any string PS does not recognise
    // is treated as Custom and works the same way.
    rnDesc.putString(sTID('preset'), 'Default');

    executeAction(sTID('denoise'), rnDesc, DialogModes.NO);

    return {
      applied: true,
      filter: 'Reduce Noise',
      strength: %s,
      preserve_details: %s,
      color_noise: %s,
      sharpen_details: %s,
      remove_jpeg_artifact: %s,
      per_channel: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applyHighPass. Slots: 1=getMinimalContextInfo, 2=helperFunctions,
		// 3=duplicateForOp, 4=radius, 5=radius (result).
		// applyDisplace — AM Dspl. The displacement-MAP file is carried in the
		// descriptor via putPath(DspF), so it runs headless (no file dialog). Slots:
		// 1=getMinimalContextInfo, 2=helperFunctions, 3=duplicateForOp, 4=hScale,
		// 5=vScale, 6=dspMap charID, 7=undefAreas charID, 8=mapPath(jsLit), then
		// result: 9=hScale, 10=vScale, 11=dspMap(jsLit), 12=undefAreas(jsLit),
		// 13=mapPath(jsLit). Ground truth confirmed via ScriptListener capture.
		vault.Displace: `
    %s

    var dsplDesc = new ActionDescriptor();
    dsplDesc.putInteger(cTID('HrzS'), %s);
    dsplDesc.putInteger(cTID('VrtS'), %s);
    dsplDesc.putEnumerated(cTID('DspM'), cTID('DspM'), cTID('%s'));
    dsplDesc.putEnumerated(cTID('UndA'), cTID('UndA'), cTID('%s'));
    var __mapFile = new File(%s);
    if (!__mapFile.exists) {
      throw new Error('Displacement map not found: ' + __mapFile.fsName);
    }
    dsplDesc.putPath(cTID('DspF'), __mapFile);
    executeAction(cTID('Dspl'), dsplDesc, DialogModes.NO);

    return {
      applied: true,
      filter: 'Displace',
      horizontal_scale: %s,
      vertical_scale: %s,
      displacement_map: %s,
      undefined_areas: %s,
      map_path: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		vault.HighPass: `
    %s

    // High Pass AM event with a single radius unitDouble.
    var hpDesc = new ActionDescriptor();
    hpDesc.putUnitDouble(sTID('radius'), sTID('pixelsUnit'), %s);
    executeAction(sTID('highPass'), hpDesc, DialogModes.NO);

    return {
      applied: true,
      filter: 'High Pass',
      radius: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applyRadialBlur — AM RdlB (no DOM method). Slots: 1=getMinimalContextInfo,
		// 2=helperFunctions, 3=duplicateForOp, 4=amount(int), 5=methodCharID,
		// 6=qualityCharID, 7=centerX, 8=centerY, then result: 9=amount,
		// 10=method(jsLit), 11=quality(jsLit), 12=centerX, 13=centerY.
		// Ground truth confirmed via ScriptListener capture.
		vault.RadialBlur: `
    %s

    // Radial Blur AM event (RdlB). Center is a normalized 0-1 point.
    var rbDesc = new ActionDescriptor();
    rbDesc.putInteger(cTID('Amnt'), %s);
    rbDesc.putEnumerated(cTID('BlrM'), cTID('BlrM'), cTID('%s'));
    rbDesc.putEnumerated(cTID('BlrQ'), cTID('BlrQ'), cTID('%s'));
    var rbCtr = new ActionDescriptor();
    rbCtr.putDouble(cTID('Hrzn'), %s);
    rbCtr.putDouble(cTID('Vrtc'), %s);
    rbDesc.putObject(cTID('Cntr'), cTID('Pnt '), rbCtr);
    executeAction(cTID('RdlB'), rbDesc, DialogModes.NO);

    return {
      applied: true,
      filter: 'Radial Blur',
      amount: %s,
      method: %s,
      quality: %s,
      center_x: %s,
      center_y: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applyPixelate — AM ClrH (color halftone) / Msc (mosaic). The mode-specific
		// descriptor block + result-detail line are built by the emitter and
		// interpolated. Slots: 1=getMinimalContextInfo, 2=helperFunctions,
		// 3=duplicateForOp, 4=descriptor block, 5=mode(jsLit), 6=result fields.
		// Ground truth confirmed via ScriptListener capture (ClrH + Msc events).
		vault.Pixelate: `
    %s

    // Pixelate AM event (mode-specific descriptor built by the emitter).
    %s

    return {
      applied: true,
      filter: 'Pixelate',
      mode: %s,
      %s
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applyDistort — AM Twrl / Rple / Plr / Wave. Mode-specific descriptor block
		// + result-detail line built by the emitter. Slots: 1=getMinimalContextInfo,
		// 2=helperFunctions, 3=duplicateForOp, 4=descriptor block, 5=mode(jsLit),
		// 6=result fields. Ground truth confirmed via ScriptListener capture.
		vault.Distort: `
    %s

    // Distort AM event (mode-specific descriptor built by the emitter).
    %s

    return {
      applied: true,
      filter: 'Distort',
      mode: %s,
      %s
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// Shared multi-mode filter skeleton. Used by applyStylize/
		// applyRender/applyOther/applyDenoise/applyBlurAdv. Same shape as the Distort
		// skeleton but the filter label is a slot so one fragment serves every family.
		// Slots: 1=getMinimalContextInfo, 2=helperFunctions, 3=duplicateForOp,
		// 4=descriptor block, 5=filter label(jsLit), 6=mode(jsLit), 7=result fields.
		vault.FilterMulti: `
    %s

    // Filter AM event (mode-specific descriptor built by the emitter).
    %s

    return {
      applied: true,
      filter: %s,
      mode: %s,
      %s
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applyOilPaint — AM oilPaint. Slots: 1=getMinimalContextInfo,
		// 2=helperFunctions, 3=duplicateForOp, 4=lightingOn, 5=stylization,
		// 6=cleanliness, 7=brushScale, 8=microBrush, 9=lightDirection, 10=specularity,
		// then result: 11=stylization, 12=cleanliness, 13=brushScale, 14=bristleDetail,
		// 15=lightDirection, 16=shine, 17=lightingOn.
		// Ground truth confirmed via ScriptListener capture.
		vault.OilPaint: `
    %s

    // Oil Paint AM event (oilPaint). Requires GPU/OpenCL — if unavailable PS
    // throws, which surfaces as the wrapped error.
    var opDesc = new ActionDescriptor();
    opDesc.putBoolean(sTID('lightingOn'), %s);
    opDesc.putDouble(sTID('stylization'), %s);
    opDesc.putDouble(sTID('cleanliness'), %s);
    opDesc.putDouble(sTID('brushScale'), %s);
    opDesc.putDouble(sTID('microBrush'), %s);
    opDesc.putInteger(cTID('LghD'), %s);
    opDesc.putDouble(sTID('specularity'), %s);
    executeAction(sTID('oilPaint'), opDesc, DialogModes.NO);

    return {
      applied: true,
      filter: 'Oil Paint',
      stylization: %s,
      cleanliness: %s,
      brush_scale: %s,
      bristle_detail: %s,
      light_direction: %s,
      shine: %s,
      lighting_on: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,
	})
}
