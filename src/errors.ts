/**
 * Something the person typed cannot work.
 *
 * The difference matters to whoever writes a client against this: 400 means "you asked for something
 * impossible, read the message and fix it", while 500 means "we broke, this is not your fault". A
 * mistyped proxy answering 500 tells them to file a bug that does not exist.
 */
export class InputError extends Error {}
