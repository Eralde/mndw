import * as vue from 'vue';

export interface StatefulRow {
  id: string;
  name: string;
}

export const vueCellLifecycle = {setup: 0, mounted: 0, destroyed: 0};

export const StatefulCell = vue.defineComponent({
  props: {
    row: {type: Object as vue.PropType<StatefulRow>, required: true},
    value: {type: String, required: true},
    colId: {type: String, required: true},
  },
  setup(props) {
    vueCellLifecycle.setup += 1;
    vue.onMounted(() => {
      vueCellLifecycle.mounted += 1;
    });
    vue.onUnmounted(() => {
      vueCellLifecycle.destroyed += 1;
    });

    const count = vue.ref(0);

    return () =>
      vue.h(
        'button',
        {
          class: 'stateful-cell',
          onClick: () => {
            count.value += 1;
          },
        },
        `${count.value}|${props.value}|${props.row.name}|${props.colId}`,
      );
  },
});
