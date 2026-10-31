const wrap = (meta) => ({
  default: (d) => ({ meta: { ...meta, default: d } }),
  meta
});
const z = {
  object: (props) => ({ meta: { type: "object", properties: props } }),
  boolean: () => wrap({ type: "boolean" }),
  string: () => wrap({ type: "string" }),
  number: () => wrap({ type: "number" }),
  array: () => wrap({ type: "array" })
};
export default z;
