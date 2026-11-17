/**
 * A record while it is being built.
 *
 * The Effect schemas that describe stored records mark every member
 * `readonly`, so a record whose optional members are decided one condition at
 * a time cannot be written through the schema's own type. This is the same
 * shape with the modifier lifted: every member the schema allows is
 * assignable, and the finished value is still checked against the schema type
 * where it is returned or stored.
 */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
