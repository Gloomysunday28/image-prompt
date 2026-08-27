# Prompt blueprints

Choose the smallest form that gives the model reliable control. Replace bracketed planning labels with finished prose; never return empty placeholders unless the user explicitly requests a reusable template.

## Cinematic long-form

Use for monumental worlds, live-action wuxia, biomechanical warriors, mythology, or exact reference-image reconstruction.

```markdown
[Aspect ratio and capture identity]

[What the image must look like]
[What it is not]

---

# Overall style
[Primary route, production scale, emotional beat]

# Scene
[Place, history, current state, real-world logic]

# Camera and composition
[Camera family, lens, height, distance, angle, subject position/occupancy]
[Foreground → midground → background → leading line]

# Subject
[Anatomy, pose, gaze, action, silhouette]

# Costume / armor / prop
[Construction, materials, wear, physical interaction]

# Environment and scale
[Architecture, infrastructure, depth, scale evidence]

# Weather and atmosphere
[Wind, rain, haze, dust, physically continuous behavior]

# Light and color
[Source direction, exposure, cold/warm relationship, restrained palette]

# Camera realism
[Optical imperfections, motion blur, sensor/film texture, restrained VFX]

# Positive keywords
[Short English reinforcement block]

# Negative Prompt
[Route-specific failure modes]
```

Do not add every possible section. Keep only sections that control a visible decision.

## Dreamlike photographic long-form

Use for a real traveler encountering one impossible phenomenon.

1. Establish the ordinary location and credible camera position.
2. Lock subject distance, rear/first-person angle, and foreground scale.
3. Describe the normal ground, deck, road, sea, vegetation, or weather.
4. Introduce exactly one impossible sky, water, animal, or celestial phenomenon.
5. Explain its physical interaction with cloud, light, reflection, occlusion, and atmosphere.
6. End with the emotional discovery and a Negative Prompt blocking poster/game/spacecraft drift.

## Character-design long-form

Use when the environment is secondary or absent.

Organize visible design from silhouette to detail:

1. Human identity and body proportions.
2. Pose and framing.
3. Head/helmet/hair silhouette.
4. Shoulder and torso structure.
5. Arms, exposed joints, waist/skirt armor, legs, and footwear.
6. Textile elements and their wind/gravity behavior.
7. Weapon dimensions, grip, orientation, and material.
8. Surface wear and palette hierarchy.
9. Explicit forbidden shapes that commonly replace the intended design.

## Compact prompt

Use for imperfect phone photography, retro illustration, healing images with simple composition, or a quick concept.

Write one dense paragraph containing:

`medium + subject/action + setting + composition + light/weather + palette + texture + emotional tone + essential exclusions`

Keep one visual priority and avoid repetitive quality adjectives.

## Parametric game prompt

Use English and preserve this placeholder syntax:

```text
{argument name="variable name" default="usable default value"}
```

Define title, environment, creatures, held item, and any changeable UI values as separate variables. Keep fixed layout rules outside placeholders so variants preserve the same screenshot structure.

## Reference-image reconstruction

Translate visible relationships rather than listing objects:

- Write the subject's exact side and foreground depth.
- Estimate camera height, horizontal offset, angle, and lens family.
- Identify the strongest diagonal, frame, vanishing line, or negative-space field.
- State which object is closest to the camera and how perspective enlarges it.
- Preserve the order of visual importance.
- Separate visible evidence from user-requested changes.
- Do not invent a front view, hidden face, unseen costume detail, or off-frame object unless the user asks for creative completion.

## Prompt optimization

When improving an existing prompt:

1. Preserve all user-locked facts.
2. Remove contradictions before adding detail.
3. Replace vague adjectives with camera, geometry, material, or lighting constraints.
4. Consolidate duplicate wording only when the user requests editing rather than literal preservation.
5. Strengthen the most failure-prone section first: composition, anatomy, scale, material, or Negative Prompt.
6. Return the complete revised prompt, not a patch, unless the user asks for a change list.

## Negative Prompt selection

- **Live action:** block concept art, digital painting, game screenshot, Unreal-style rendering, plastic skin, clean CGI, magic glow, poster composition, excessive HDR, oversharpening, and physically impossible architecture as relevant.
- **Dreamlike photography:** block poster layout, spacecraft cues, fake fog, decorative light beams, disconnected reflections, excessive phenomena, and artificial depth of field.
- **Illustration:** block photoreal mismatches, 3D gloss, muddy color, vector-flat geometry, or modern ad layout only when they conflict with the route.
- **Candid photography:** block beauty retouching, studio pose, perfect symmetry, fashion editorial light, and commercial polish.
- **Game template:** block missing HUD, wrong viewpoint, unreadable interface, non-voxel geometry, and unspecified inventory.

Never ban a feature required by the positive prompt.
