type Brand = typeof __b;
declare const __b: unique symbol;
class Opt<T> { declare readonly __optionalBrand: Brand; constructor(public v: T){} }
class Str { }
type Shape = { path: Str; maxBytes: Opt<number> };
type IsOpt<F> = F extends { readonly __optionalBrand: Brand } ? true : false;
type A = IsOpt<Str>;       // expect false
type B = IsOpt<Opt<number>>; // expect true
declare const a: A; declare const b: B;
console.log(a, b);
