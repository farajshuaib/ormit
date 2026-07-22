import { DbContext, type DbContextOptions, type ModelBuilder } from '@ormit/core';
import { User, Post, defineModel } from './models.js';

export class AppDb extends DbContext {
  users = this.set(User);
  posts = this.set(Post);

  constructor(options: DbContextOptions) {
    super(options);
  }

  protected onModelCreating(m: ModelBuilder): void {
    defineModel(m);
  }
}
