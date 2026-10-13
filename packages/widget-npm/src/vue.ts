import { defineComponent, onBeforeUnmount, onMounted, type PropType } from "vue";
import { init, type InitOptions } from "./index.ts";

/**
 * `snagset/vue`.
 *
 * ```vue
 * <script setup>
 * import { Snagset } from "snagset/vue";
 * </script>
 *
 * <template>
 *   <Snagset host="https://review.example.com" site="prj_…" />
 * </template>
 * ```
 *
 * Same shape as the React one and for the same reason: renders nothing, mounts
 * on mount, tears down on unmount. `vue` is an optional peer dependency.
 *
 * Written with `defineComponent` and a render function rather than as an SFC
 * because an SFC needs `@vitejs/plugin-vue` at BUILD time — in this package's
 * build, not the consumer's. A component that renders null does not need a
 * template compiler, and adding one would make the Vue subpath the only part
 * of this package that cannot be built by `tsc`.
 */
export const Snagset = defineComponent({
  name: "Snagset",
  props: {
    host: { type: String, required: true },
    site: { type: String, required: true },
    env: String,
    mode: String,
    theme: String,
    lang: String,
    position: String,
    hotkey: String,
    branch: String,
    build: String,
    storage: String,
    badge: String as PropType<string>,
    autoMount: String as PropType<string>,
  },
  setup(props) {
    let teardown: (() => void) | undefined;
    onMounted(() => {
      // `{ ...props }` rather than `props`: Vue's props object is a reactive
      // proxy, and handing it to a plain function that iterates it later would
      // read values through the proxy outside of any effect scope.
      teardown = init({ ...props } as InitOptions);
    });
    onBeforeUnmount(() => teardown?.());
    return () => null;
  },
});

export default Snagset;
