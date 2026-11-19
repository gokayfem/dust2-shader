export function createChallenge(entities, models) {
  const sites = ['tgt_a', 'tgt_b'].map((target) => {
    const entity = entities.find((entry) => (
      entry.classname === 'func_bomb_target' && entry.target === target
    ));
    const model = entity?.model?.startsWith('*') ? models[Number(entity.model.slice(1))] : null;
    if (!model) throw new Error(`BSP is missing the challenge bounds for ${target}.`);
    return { min: model.mins, max: model.maxs };
  });
  let stage = 0;
  let seconds = 0;

  return {
    step(origin, dt) {
      if (stage >= sites.length) return;
      seconds += dt;
      const { min, max } = sites[stage];
      if (origin.every((value, axis) => value >= min[axis] && value <= max[axis])) stage++;
    },
    reset() {
      stage = 0;
      seconds = 0;
    },
    get stage() { return stage; },
    get seconds() { return seconds; },
  };
}
