/**
 * The model is the single source of truth in migration-first Ormit: you never
 * hand-write DDL or introspect a live database. Change these classes, then run
 * `pnpm migrations:add <name>` — the CLI diffs this model against the last
 * *committed* snapshot and emits the migration + inverse for you.
 */
import type { ModelBuilder } from '@ormit/core';

export class User {
  id!: number;
  name!: string;
  email!: string;
  bio!: string | null;
  posts!: Post[];
}

export class Post {
  id!: number;
  title!: string;
  body!: string;
  authorId!: number;
  author!: User;
  createdAt!: Date;
}

export function defineModel(m: ModelBuilder): void {
  m.entity(User, (e) => {
    e.toTable('users').hasKey('id');
    e.property((x) => x.name).hasMaxLength(120).isRequired();
    e.property((x) => x.email).hasMaxLength(200).isRequired();
    e.property((x) => x.bio).isRequired(false);
    e.hasIndex('email').isUnique().hasName('ix_users_email');
  });

  m.entity(Post, (e) => {
    e.toTable('posts').hasKey('id');
    e.property((x) => x.title).hasMaxLength(200).isRequired();
    e.property((x) => x.body).isRequired();
    e.property((x) => x.createdAt).hasType('Date').hasDefaultSql('CURRENT_TIMESTAMP');
    // Shadow FKs default to CLR type 'unknown' (text) unless typed explicitly —
    // give it a real integer column so joins/includes compare numerically.
    e.property((x) => x.authorId).hasType('number');
    e.hasOne(User, (x) => x.author)
      .withMany((u) => u.posts)
      .hasForeignKey('authorId')
      .onDelete('cascade');
  });
}
