/**
 * Something the person typed cannot work.
 *
 * The difference matters to whoever writes a client against this: 400 means "you asked for something
 * impossible, read the message and fix it", while 500 means "we broke, this is not your fault". A
 * mistyped proxy answering 500 tells them to file a bug that does not exist.
 */
export class InputError extends Error {}

/**
 * Known, and not allowed this. A key bound to one project asking for something outside it is not a
 * stranger — 401 would send whoever reads it off to check a key that works — so it gets its own answer.
 */
export class Forbidden extends Error {}
