import type { ModelStatic } from 'sequelize';

export class NotCachedError extends Error {
  constructor(model: ModelStatic<any>) {
    super(`Model ${model.name} is not cached`);
  }
}
