# @mndw/ui

[English](README.md) | **Русский**

Независимые от фреймворка custom elements для плагинов mndw и страниц хоста. Компоненты читают
опубликованные хостом дизайн-токены `--mndw-*`; этот пакет не импортирует `tokens.css`.

## Регистрация

Хост — единственный регистратор, поскольку `customElements.define` действует глобально в пределах страницы.

```ts
import {defineMndwUi} from '@mndw/ui';

defineMndwUi({overlay: uiOverlayService});
```

Плагины используют элементы напрямую. `@mndw/ui` — общая зависимость, выносимая во внешнюю
зависимость при pack. Без overlay элемент `<mndw-select>` использует минимальный fallback с
фиксированным позиционированием для самостоятельного использования.

## Элементы

| Element              | Notes                                                                                                                                |
|----------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `<mndw-select>`      | Дочерние `<mndw-option>` передаются через slot. Испускает `mndwchange`.                                                               |
| `<mndw-option>`      | Декларативные данные варианта и богатое содержимое label; сообщает об изменениях.                                                  |
| `<mndw-checkbox>`    | Испускает `mndwchange`; участвует в форме с `name`, `value`, `required` и `invalid`.                                                   |
| `<mndw-button>`      | `variant="primary"`, `"secondary"`, `"ghost"` или `"danger"`; `type="button"`, `"submit"` или `"reset"`.                 |
| `<mndw-scroll-area>` | Нативный viewport с постоянно видимым специальным scrollbar при переполнении.                                                      |
| `<mndw-field>`       | Обёртка label/hint/error в light DOM для одного control. Shadow root не создаёт.                                                    |
| `<mndw-input>`       | Внутренний нативный `<input>` с делегированным фокусом. Испускает `mndwinput` и `mndwchange`.                                       |
| `<mndw-textarea>`    | Внутренний нативный `<textarea>`; размер через `rows` и необязательный `autosize`. Те же события.                                    |
| `<mndw-switch>`      | `role="switch"` на host; переключатель с немедленным эффектом. Испускает `mndwchange`.                                             |
| `<mndw-segmented>`   | `role="radiogroup"` со slot-дочерними `<mndw-segment>`. Испускает `mndwchange`.                                                      |
| `<mndw-segment>`     | Один вариант в segmented-группе; только `value` и `disabled`.                                                                       |
| `<mndw-slider>`      | `role="slider"` на host; числовой диапазон с перетаскиванием указателя. Испускает `mndwinput` и `mndwchange`.                     |
| `<mndw-tabs>`        | Контейнер с внутренним `tablist`, активным `value` и ARIA дочерних элементов. Испускает `mndwchange`.                               |
| `<mndw-tab>`         | Один tab; только обязательный `id` и `disabled`.                                                                                     |
| `<mndw-tab-panel>`   | Содержимое одного tab; `for` указывает на `id` этого tab.                                                                           |
| `<mndw-tooltip>`     | Описывает первый slot-элемент при наведении и фокусе. В формах не участвует.                                                        |
| `<mndw-line-chart>`  | Временной line/area chart с несколькими рядами; данные передаются через properties.                                               |
| `<mndw-bar-chart>`   | Временной позиционный bar chart; данные передаются через properties.                                                                |
| `<mndw-sparkline>`   | Компактная столбчатая диаграмма процентов; данные передаются через `points`.                                                        |
| `<mndw-heat-strip>`  | Компактная тепловая полоса загрузки; данные передаются через `points`.                                                              |
| `<mndw-table>`       | Нейтральная к фреймворку таблица; `columns`/`rows` — properties, управляемые сортировка/выбор/видимость и light-DOM cell renderers. |
| `<mndw-column-menu>` | Портальная ARIA `menu` для видимости колонок, которой владеет `<mndw-table>`; напрямую не открывается.                             |

`<mndw-select>` использует привязанный popover выше `600px`, а его максимальная высота вычисляется
по доступному месту viewport. Длинные desktop-списки прокручиваются во вложенной нативной
scroll area панели; панель владеет border, radius, background, shadow, clipping и стабильным
scrollbar gutter. При `<=600px` элемент открывается как полноширинный bottom sheet, размером по
содержимому до viewport, с title/close chrome, backdrop, блокировкой прокрутки и прокручиваемой
областью вариантов для длинного списка. В режиме sheet панель имеет размер по содержимому до
viewport; вложенная область вариантов отвечает за прокрутку. Заголовок sheet берётся из `label`,
а при его отсутствии используется `Select option`.

Breakpoint вычисляется по `window.innerWidth` в момент открытия. Изменение размера через `600px`
не меняет уже открытый слой; чтобы применить другое представление, закройте и откройте его снова.
Containment фокуса хостом для sheet не реализован; нажатие `Tab` закрывает панель и возвращает
фокус триггеру.

События написаны в нижнем регистре без дефисов (`mndwchange`) для vanilla, Svelte, Vue и Angular.

### Charts

Charts принимают нормализованные данные с временем в миллисекундах эпохи. Массивы и объекты
назначаются как DOM properties, а не сериализуются в attributes:

```ts
import type {MndwChartSeries, MndwLineChartProps} from '@mndw/ui';

const series: MndwChartSeries[] = [
  {
    id: 'upload',
    label: 'Upload',
    color: 'accent',
    fill: true,
    data: [
      {time: 1_700_000_000_000, value: 100},
      {time: 1_700_000_060_000, value: 200},
    ],
  },
];

const lineOptions: MndwLineChartProps = {
  series,
  domain: {start: 1_700_000_000_000, end: 1_700_000_060_000},
};
const line = document.querySelector('mndw-line-chart');

if (line !== null) {
  Object.assign(line, lineOptions);
}
```

`MndwChartPoint` требует время в миллисекундах эпохи; `MndwChartSample` делает `time`
необязательным для компактных charts. `<mndw-line-chart>` предоставляет `series`, необязательный
`domain`, `valueLabel` и callbacks представления. `<mndw-bar-chart>` предоставляет `points`,
`valueLabel`, `color` и те же callbacks; он использует позиционные band slots и не имеет
time-domain property. `<mndw-sparkline>` и `<mndw-heat-strip>` предоставляют `points`, `max`,
`valueLabel` и callbacks представления. `points`, `series`, `domain` и callbacks доступны только
как properties. Строковые attributes используют явные имена с дефисами: `empty-label="No data"`
и `value-label="Throughput"`.

`*Props` — необязательные наборы входных данных для назначения объекта; даже инициализированные
custom-element instances предоставляют конкретные defaults, например `points = []`,
`color = "accent"` и `max = 100`. После изменения данных заменяйте properties массивов новым
экземпляром массива.

Все charts принимают callbacks `valueFormatter(value)` и `timeFormatter(epochMs)`. По умолчанию
для значений line/bar используется форматирование скорости сети, для компактных значений —
округлённые проценты, а для часов — локальные метки `HH:MM:SS`. Компактные оси отображаются
только если у каждого нормализованного sample есть конечное время; смешанные timed и untimed
samples выводятся без оси. Некорректные значения compact `max` разрешаются в `100` для
отрисовки, но tooltips и accessibility сохраняют фактические значения samples. Цвета sparkline
и bar используют `accent`, `success`, `warning` или `muted`; некорректные runtime colors
заменяются на `accent`. Цвета heat-strip всегда используют шкалу загрузки.

Line и bar charts предоставляют parts `container`, `plot`, `grid`, `axis`, `tooltip` и `empty`.
Sparkline и heat-strip предоставляют `container`, `plot`, `axis`, `tooltip` и `empty`; компактная
`axis` появляется только для полностью timed data. Tooltips локальны для plot; перерисовка данных
очищает устаревшее состояние tooltip и не показывает его снова, пока указатель не переместится.

Все chart hosts имеют `role="img"`. Авторский `aria-label` имеет приоритет. Иначе line использует
`label` или `id` каждого series, а bar и compact используют `value-label` или нейтральное
локализованное `Values`; пустые charts используют вычисленный `empty-label`. Эти fallback не
предполагают vocabulary конкретного плагина. `formatSpeed` экспортируется для потребителей,
которым нужен такой же текст вне chart, например для summary, принадлежащего плагину.

`<mndw-checkbox>` и `<mndw-select>` участвуют в отправке формы через `ElementInternals`. Непроверенные
checkbox и пустые либо не совпавшие select исключаются из `FormData`. Оба control восстанавливают
авторские defaults при reset формы и сочетаются с `<fieldset disabled>`. Их roles и точки фокуса
находятся на host, поэтому внешние `<label for>` работают как ожидается.
### `<mndw-table>`

Общая нейтральная к фреймворку таблица. Плагины объявляют `columns` (через curried builder
`column<Row>()`) и при каждом обновлении назначают `rows` новой ссылкой на массив; таблица
управляет сортировкой, выбором checkbox с select-all, перетаскиванием/перестановкой строк с
клавиатуры и единообразным скрытием/показом колонок. Сложные значения (`columns`, `rows`, `rowKey`,
`selected`, `sort`, `hiddenColumns`, `rowLabel`, `labels`) доступны только как properties;
строковые/перечислимые поля используют явные kebab-case attributes: `row-key` (только строковая
форма), `sort-mode`, `empty-label`, `caption`, `column-menu-panel-class`, `layout`, `min-width`
и `sticky-header`.

```ts
import {column} from '@mndw/ui';

interface NodeRow {
  id: string;
  node: {name: string; ip: string; clients: number};
}

const columns = [
  column<NodeRow>()({id: 'name', label: 'Name', accessor: (row) => row.node.name, sortable: true}),
  column<NodeRow>()({id: 'ip', label: 'IP', accessor: (row) => row.node.ip}),
  column<NodeRow>()({
    id: 'clients',
    label: 'Clients',
    accessor: (row) => row.node.clients,
    kind: 'number',
    sortable: true
  }),
];

const table = document.querySelector('mndw-table');
table.rowKey = 'id';
table.columns = columns;
table.rows = nodeRows;
table.sort = {columnId: 'name', direction: 'asc'};
```

Сортировка и выбор управляемые: таблица отрисовывает данные из `sort` и `selected` и испускает
`mndwsortchange` / `mndwselectionchange` / `mndwrowreorder` / `mndwcolumnvisibilitychange` /
`mndwerror` (все с { bubbles: true, composed: true }); плагин записывает property обратно.
Видимость колонок поддерживает оба режима: с `hiddenColumns` она управляемая; без него встроенное
column menu (портальный `<mndw-column-menu>`) управляет `internalHidden` и всё равно информативно
испускает `mndwcolumnvisibilitychange`. `columnMenu={false}` отключает menu.

`rowKey` обязателен и разрешается в непустую строку для каждой строки (имя поля или `(row) => string`).
Пустые или повторяющиеся ключи и дублирующиеся id колонок исключают ошибочные rows/columns,
показывают видимую part `error` с `role="alert"` и один раз испускают `mndwerror` при каждом
изменении набора нарушений.

Раскрываемые таблицы показывают управляемую встроенную detail-row с `expandable`, `expandOn` и
`expandedRenderer`. Задайте `toggleCell` как `leading` или `trailing` для размещения utility-column
либо `toggleAfterColumn` как id видимой колонки, чтобы поместить chevron рядом с ней. Значения
`width` колонок применяются к header и body cells; utility columns выбора и раскрытия остаются узкими.

Установите `Column.sticky: 'start'`, чтобы закрепить непрерывный начальный ряд видимых data
columns у логического inline-start edge. Каждая закреплённая колонка обязана объявить `width`;
не начальная или не имеющая width sticky-колонка остаётся незакреплённой, устанавливает
`data-mndw-sticky-inactive="not-leading"` или `"missing-width"` и выдаёт одно development warning.
Начальные utility cells выбора, drag и expand закрепляются перед этим рядом. Смещения используют
логические `inset-inline-start` и `border-inline-end`, поэтому pinning корректен для RTL;
закреплённые cells предполагают фон `--mndw-surface`. При `reorderable` закреплённая drag-column
ограничивается `2.5rem` — это известное косметическое ограничение.

Установите `Column.nowrap: true`, чтобы применить `white-space: nowrap` к header и body cells этой
колонки. `layout="auto"` использует `table-layout: auto` и `width: max-content` для размеров по
содержимому и горизонтальной прокрутки; virtualization сохраняет fixed layout и выставляет
`data-mndw-layout-inactive="virtual"`. `min-width` добавляет inline `min-width` к таблице и может
вызвать горизонтальное переполнение. `sticky-header` делает header принадлежащим компоненту и
липким; вместе с pinned column верхняя левая ячейка закрепляется по обеим осям.

#### Динамическая виртуализация

Установите `virtual`, `estimatedRowHeight` (по умолчанию `49`) и пиксельный `overscan` (по
умолчанию `400`), чтобы отрисовывать ограниченное непрерывное окно, сохраняя проверку,
сортировку, выбор, раскрытие и поиск `scrollToRow()` по полному массиву `rows`.
`estimatedRowHeight` — только оценка до измерения; после четырёх корректных сводных измерений
текущее среднее заменяет её для текущей width epoch. `overscan={0}` допустим. Некорректные
настройки используют defaults и не создают data violations. Числовые attributes — это
`estimated-row-height` и `overscan`.
Virtual mode требует viewport с ограниченной высотой для ограниченной работы DOM. Он использует
нативные строки `virtual-spacer` положительной высоты, прямое измерение `<tr>`, коррекцию anchor
по key и `ResizeObserver`. Cell renderers вне активного окна уничтожаются; при прокрутке обратно
монтируются новые instances. Данные, нужные за этой границей, храните в state потребителя.
Viewport владеет прокруткой и принудительно устанавливает `overflow-anchor: none`, мгновенное
внутреннее перемещение и `scrollbar-gutter: stable`.

`scrollToRow(key, {align})` принимает `start`, `center`, `end` или `nearest` (по умолчанию).
Для отсутствующего корректного key возвращается `false`, иначе `true`; глубокие неизмеренные
targets сначала попадают на estimates, а затем корректируются после измерения. `virtual &&
reorderable` переключается на полную отрисовку и выставляет `data-mndw-virtual-inactive="reorderable"`.
Если `ResizeObserver` недоступен, причина fallback — `resize-observer-unavailable`. Ни один
fallback не меняет логическое поведение.

#### Адаптеры фреймворков

Встроенные `kind`: `text`, `number`, `badge` и неинтерактивный glyph `boolean`. Богатые cells
используют `CellRenderer` (`mount`/`update`/`destroy`), переданный через `column.renderer`, и
отрисовываются в припаркованном light-DOM node, чтобы scoped styles ячейки плагина применялись.
Framework adapters (`@mndw/ui-svelte`, `@mndw/ui-vue`, `@mndw/ui-angular`) превращают нативные
cells в renderers. Parts: `viewport`, `table`, `caption`, `header`, `header-cell`,
`sort-indicator`, `row`, `cell`, `select-cell`, `select-all`, `drag-handle`,
`column-menu-trigger`, `empty`, `error`. Menu panel портален, поэтому стилизуется через
`column-menu-panel-class`, а не `mndw-table::part(...)`.

Внутренний viewport также имеет class `mndw-table-viewport`. Потребители должны держать table
controls в sibling-регионе light DOM с именем `mndw-table-controls`; viewport — единственный
владелец горизонтальной прокрутки. Class и `part="viewport"` — стабильные hooks для потребителей
host, Vue и Angular.

Адаптеры монтируют в припаркованный node при mount/update и размонтируют при destroy; при старте
хост регистрирует `@mndw/ui` до mount плагина, поэтому им не нужно ждать
`customElements.whenDefined()`.

```ts
// Angular — mndwCell directive on an ng-template
column<NodeRow>()({id: 'name', label: 'Name', accessor: (r) => r.node.name, sortable: true})
// <ng-template mndwCell="name" [mndwCellRows]="rows()" let-row>{{ row.node.name }}</ng-template>
```

```svelte
<script lang="ts">
  import {svelteCell} from '@mndw/ui-svelte';
  import PackageNameCell from './PackageNameCell.svelte';
  export const nameCell = svelteCell<PackageEntry, string>()(PackageNameCell)();
</script>
```

```ts
// Vue — defineComponent or functional component
import {vueCell} from '@mndw/ui-vue';
import ClientNameCell from './ClientNameCell.vue';

const nameCell = vueCell<ClientRecord, string>()(ClientNameCell)();
```

### `<mndw-field>`

Field принимает control как ребёнка light DOM и сам настраивает labelling. Он отрисовывается в
light DOM, поэтому предоставляет classes, а не `::part()`:

```html

<mndw-field label="Host name" hint="Shown in the device list." error="" required>
    <input name="hostname"/>
</mndw-field>
```

Properties: `label`, `hint`, `error` и `required`; все являются строками, кроме `required`, а
пустая строка скрывает node вместо пустой отрисовки. Field один раз создаёт ровно три node —
`label.mndw-field__label`, `.mndw-field__hint` и `.mndw-field__error` (у последнего `role="alert"`
и classes `.mndw-alert--danger`) — и располагает их вокруг control в порядке label, control,
hint, error. Control — первый дочерний `Element`, поэтому comments, placeholder nodes и whitespace
пропускаются, а замена control автоматически перестраивает связи.

Field владеет только тем, что записывает. Он генерирует `id` control, если его нет, связывает
`<label for>` с этим id, добавляет id hint/error в `aria-describedby`, устанавливает
`aria-invalid`, когда `error` не пуст, и зеркалит `required`. Переданные потребителем ids,
tokens describedby и прежние значения attributes сохраняются и восстанавливаются; control, который
нельзя label, получает имя через `aria-labelledby`, указывающий на собственный label field.

**Собственное имя control всегда имеет приоритет.** Field не выводит label, если у control
непустой `aria-label`, `aria-labelledby` указывает за пределы field, в том же tree есть
потребительский `<label for>` или control имеет собственный declared label source. Control
объявляет такой source как статический `mndwLabelSource`: `<mndw-checkbox>` использует `'slot'`
(его slot-содержимое — имя), а `<mndw-select>` — `'label-property'` (его property `label` —
имя). Control, у которого label source может измениться после mount, испускает
`mndwlabelchange` (`bubbles`, `composed`), чтобы field перестроил связи.
### `<mndw-input>`

Текстовый control: host владеет участием в форме, а настоящий нативный `<input>` внутри shadow
root владеет редактированием, caret, selection, IME и masking. Shadow root использует
`delegatesFocus`, поэтому клик `<label for>` или `.focus()` попадает на нативный element.

```html

<mndw-field label="Listen port" hint="1–65535">
    <mndw-input type="number" name="port" min="1" max="65535" step="1">
        <span slot="suffix">s</span>
    </mndw-input>
</mndw-field>
```

Properties: `value`, `type` (`text | password | search | number | url`, default `text`; остальные
значения заменяются на `text`), `placeholder`, `readonly`, `min`, `max`, `step`, `maxlength`,
`autocomplete`, а также общие `name`, `disabled`, `required` и `invalid`. `value` — state, поэтому
он **не отражается**; attribute `value` остаётся авторским default, который восстанавливает reset
формы. Parts: `field`, `input`, `prefix` и `suffix`; `prefix` и `suffix` — slots для adornments.

Событие `mndwinput` испускается при каждом нажатии клавиши, а `mndwchange` — при commit; оба
содержат `detail: {value: string}`. Commit означает blur или Enter и происходит только если
значение отличается от значения при получении focus; Enter сбрасывает baseline, поэтому следующий
blur не испускает второе событие. Программная запись ничего не испускает и заменяет baseline,
поэтому framework bindings, записывающие `value` обратно во время render, не зацикливаются.

Поскольку объявляемый element находится в shadow root, control передаёт ему имя и описание:
`aria-labelledby` (разрешённый в text), иначе `aria-label`, иначе text связанных `<label>`
становится `aria-label` внутреннего element; `aria-describedby` становится его
`aria-description`; `aria-invalid` — из host attribute, затем property `invalid`, затем
вычисленной constraint validity — также зеркалится. Host сохраняет собственные attributes; внутрь
переносятся только разрешённые значения. Разрешение читает `textContent` без поддеревьев
`aria-hidden`, поэтому декоративный контент, например required marker `<mndw-field>`, не
объявляется, а текст, скрытый только CSS, учитывается — так же, как у нативного input.
Повторное разрешение выполняется при изменении этих host attributes и редактировании связанного
текста. Вставка, удаление или перенаправление `<label for>` в другом месте tree — единственный
случай, который ничто не отслеживает: вызовите `refreshAccessibleName()`, как это делает
`<mndw-field>`.

Валидация делегируется платформе. `type`, `required`, `min`, `max`, `step` и `maxlength`
находятся на нативном element, а host отражает его `validity` и `validationMessage` через
`ElementInternals`, поэтому форма видит тот же результат, что и с нативным `<input>`.

### `<mndw-textarea>`

Тот же текстовый control, что и `<mndw-input>`, но с нативным `<textarea>`. Он использует
описанные выше forwarding rules, участие в форме и условие commit; отличаются внутренний
element и три вытекающих из него свойства.

```html

<mndw-field label="Release notes" hint="Markdown is supported.">
    <mndw-textarea name="notes" rows="5" maxlength="2000"></mndw-textarea>
</mndw-field>
```

Properties: `value`, `rows` (default `3`), `autosize` (default `false`), `readonly` и `maxlength`,
а также общие `name`, `disabled`, `required` и `invalid`. Part — `field` и `textarea`.

**Enter не выполняет commit.** Он вставляет новую строку как нативный `<textarea>`, поэтому
`mndwchange` испускается только при blur — и всё так же лишь если значение отличается от значения
при focus. `mndwinput` не меняется.

**`autosize` включается явно**, поскольку использует `ResizeObserver`: высоту нужно пересчитывать
при изменении ширины и переносе текста, а не только при изменении value. Пока он включён, control
задаёт высоту внутреннего element по содержимому и убирает `rows`, поскольку количество строк
мешало бы; при выключении возвращается размер `rows` и очищается inline height.

### `<mndw-switch>`

Переключатель с немедленным эффектом. От `<mndw-checkbox>` он отличается семантикой, а не
стилем: switch применяет изменение сразу, checkbox отправляется вместе с формой. Настройка
тёмной темы хоста — switch; выбор пакетов — checkbox.

```html

<mndw-field label="Dark theme">
    <mndw-switch name="theme" value="dark"></mndw-switch>
</mndw-field>
```

Properties: `checked` и `value` (default `'on'`), а также общие `name`, `disabled`, `required` и
`invalid`. И `checked`, и `value` отражаются — `value` является configuration, token,
отправляемым при включённом switch. Parts: `track`, `thumb` и `label`. `mndwchange` содержит
`detail: {checked: boolean}` и испускается только при активации пользователем, не при программной
записи.

Host несёт `role="switch"`, tab stop и обработку клавиатуры; Space и Enter переключают состояние,
а track и thumb в shadow — презентационные и `aria-hidden`. `FormData` получает `value` при
checked и ничего при unchecked, а reset формы восстанавливает **attribute** `checked`.

**`required` принимается, но не действует**, как у нативного `<input type="range">`: switch
всегда содержит value, поэтому `valueMissing` не может быть true. Флаг validity и `aria-required`
не устанавливаются. `invalid` отражается для стилей; `<mndw-field>` отвечает за объявление
`aria-invalid`.

Accessible name приходит извне: `<label for>` на host или `<mndw-field>`. Slot-содержимое
отрисовывается в part `label` для самостоятельного использования, но switch не объявляет
`mndwLabelSource`, поэтому оборачивающий field всегда выводит собственный label, а не передаёт
эту задачу содержимому.

### `<mndw-segmented>` и `<mndw-segment>`
Radio group в облике segmented control, следующая идиоме `<mndw-select>` / `<mndw-option>`:
group владеет value, событиями и состоянием формы; children — декларативные.

```html

<mndw-segmented label="Range" name="range" value="day">
    <mndw-segment value="day">Day</mndw-segment>
    <mndw-segment value="week">Week</mndw-segment>
    <mndw-segment value="month" disabled>Month</mndw-segment>
</mndw-segmented>
```

Group несёт `value`, author-facing `label` и общие `name`, `disabled`, `required` и `invalid`;
`value` — state и не отражается. Part — `group`. `mndwchange` содержит `detail: {value: string}`
и испускается только при активации пользователем. Каждый `<mndw-segment>` несёт только
`value` (обязательный, отражаемый) и `disabled` (отражаемый), с содержимым в default slot и
part `segment`. Segment без `value` игнорируется, а не считается ошибкой.

`role="radiogroup"` находится на group, а `role="radio"` — на каждом segment; group записывает
вместе с ними `aria-checked`, `aria-disabled` и roving `tabindex` — и удаляет всё это у segment,
вышедшего из group. **Tab stop — checked segment**, либо первый enabled, если ничего не checked;
host group остаётся с `tabindex="-1"`, чтобы `form.reportValidity()` имел anchor, но Tab никогда
не попадал на него. Arrow keys перемещают и выбирают с wraparound, Home и End переходят к
первому и последнему enabled segment, Space и Enter выбирают focused segment, а disabled segments
всегда пропускаются.

Пустой выбор допустим как начальное состояние: `FormData` полностью исключает group, а
`required` сообщает `valueMissing` только пока value не совпадает ни с одним segment. Reset
восстанавливает **attribute** `value` или очищает выбор, если attribute не задан. Property `label`
— accessible name group; slot-текста для него нет, поэтому group объявляет
`mndwLabelSource = 'label-property'` и испускает `mndwlabelchange` при изменении, позволяя
оборачивающему `<mndw-field>` решить, выводить ли собственный label.

### `<mndw-slider>`

Числовой range control. Host — сам slider: он несёт `role="slider"`, tab stop, keyboard matrix и
перетаскивание pointer, а track, fill, thumb и output внутри shadow root — презентационные.

```html

<mndw-field label="Transmit power">
    <mndw-slider name="power" min="0" max="20" step="5" value="10"
                 value-text="10 dBm"></mndw-slider>
</mndw-field>
```

Properties: `value`, `min`, `max` и `step` (все `number`, defaults `0`, `100`, `1`, а `value`
по умолчанию равен `min`), `valueText` (attribute `value-text`), а также общие `name`, `disabled`,
`required` и `invalid`. `min`, `max` и `step` отражаются как configuration; `value` — state и не
отражается, поэтому attribute `value` остаётся default, восстанавливаемым reset формы. Parts:
`track`, `fill`, `thumb` и `output`.

**`value` остаётся `number` на всём пути.** Оба события содержат `detail: {value: number}` и
только form value преобразуется в строку — `FormData` всегда содержит `name` slider, поскольку
slider всегда имеет value. Любая запись ограничивается диапазоном и привязывается к сетке step,
измеренной от `min`; значение вне диапазона или сетки исправляется, а не отклоняется. Пустой
`valueText` оставляет `aria-valuetext` неназначенным, чтобы браузер объявил `aria-valuenow`;
непустой объявляется вместо него и также показывается в part `output`.

`mndwinput` испускается при каждом движении pointer или нажатии клавиши, которое меняет value.
`mndwchange` выполняет commit один раз при `pointerup` или `pointercancel` и только если value
отличается от значения при `pointerdown`; при работе с клавиатурой он испускается сразу после
каждого `mndwinput` в том же нажатии, как у нативного `<input type="range">`. Программная запись
не испускает ни одно событие.

Arrow keys изменяют step, PageUp и PageDown переходят на десятую часть диапазона (но не меньше
одного step), Home и End устанавливают `min` и `max`. **`required` принимается, но не действует**,
как у `<mndw-switch>`; control вычисляет `rangeUnderflow`, `rangeOverflow` и `stepMismatch`,
что обычно не даёт ни одного флага — нормализация сохраняет value допустимым, и эти флаги
возникают для противоречивой конфигурации вроде `min` больше `max`. Accessible name приходит
извне: `<label for>` на host или `<mndw-field>`.

### `<mndw-tabs>`, `<mndw-tab>` и `<mndw-tab-panel>`

Три элемента, одна связь. Group владеет активным `value`, keyboard matrix и каждым ARIA-
атрибутом children; children декларативны.

```html

<mndw-tabs value="network">
    <mndw-tab id="general">General</mndw-tab>
    <mndw-tab id="network">Network</mndw-tab>
    <mndw-tab id="advanced" disabled>Advanced</mndw-tab>
    <mndw-tab-panel for="general">General settings</mndw-tab-panel>
    <mndw-tab-panel for="network">Network settings</mndw-tab-panel>
</mndw-tabs>
```

`<mndw-tabs>` несёт `value` — `id` active tab, state, поэтому не отражается — и part `tablist`.
У него **нет собственной role**: превращение group в `tablist` ошибочно включило бы panels,
поэтому role находится на внутренней обёртке, куда передаются только tabs. `mndwchange` содержит
`detail: {value: string}` и испускается только при активации пользователем. В формах не участвует;
выбор tab — состояние view, а не данные формы.

`<mndw-tab>` несёт обязательный `id` и `disabled`, part `tab`. `<mndw-tab-panel>` несёт `for` —
id своего tab — и сгенерированный id `mndw-tab-panel-N`, если потребитель не задал его, part
`panel`. **Panel указывает на tab, а не наоборот**, что отражает ARIA relationship и позволяет
переставлять tabs или условно их отображать без поломки каждой ссылки; `for` на
`<mndw-tab>` вызывает `console.warn` с указанием правильного элемента.

Group записывает на tabs `role`, `aria-selected`, `aria-controls`, `aria-disabled`, roving
`tabindex` и `slot="tab"`, а на panels — `role`, `aria-labelledby` и `hidden`; при выходе child
или disconnect group удаляет ровно эти значения. Связи перестраиваются при изменении `id` tab,
`for` panel или порядка children. Активация **автоматическая**: arrow keys одновременно
перемещают focus и selection с wraparound, Home и End переходят к первому и последнему enabled
tab, disabled tabs пропускаются. Неактивный panel получает `hidden`, а не unmount, поэтому его
содержимое покидает accessibility tree и tab order, сохраняя своё state.

Некорректная разметка деградирует без исключения, каждая проблема сообщается один раз: panel,
чей `for` не совпадает ни с одним tab, остаётся hidden; tab без `id` становится inert (на него
нельзя сослаться и его нельзя выбрать); если два panel заявляют один tab, выигрывает первый в
порядке документа.

### `<mndw-tooltip>`

Оборачивает trigger и описывает его. Properties: `text`, `placement` (`top | bottom | left | right`,
default `top`) и `delay` (ms до показа, default `500`; скрытие немедленное). Part `tooltip`.

```html

<mndw-tooltip text="Restarts the device immediately" placement="bottom">
    <mndw-button variant="danger">Restart</mndw-button>
</mndw-tooltip>
```

Первый назначенный element default slot — trigger; всё после него игнорируется и один раз
выдаётся warning. Tooltip появляется при hover и focus после `delay`, скрывается при уходе
pointer, blur и Escape — Escape не поглощается, поэтому расположенный за tooltip dialog тоже
получает его. Пустой `text` ничего не отрисовывает, не несёт role и ничего не описывает, вместо
пустого bubble.

**`role="tooltip"` и id находятся на host, а не на bubble.** Token `aria-describedby` не может
пересечь shadow root, поэтому описываемым элементом должен быть host — trigger находится внутри
описанного поддерева, и screen reader объявляет сначала собственное имя trigger, затем этот текст.
Компонент добавляет в `aria-describedby` trigger только собственный id token, сохраняя все tokens
потребителя, и удаляет только его, когда `text` становится пустым, trigger заменяется, id host
изменяется или tooltip отключается. Связи перестраиваются при любом из этих изменений, включая
перезапись `aria-describedby` потребителем под компонентом.

Скрытый bubble невидим, но **не удаляется**: описание вычисляется по его тексту, поэтому `display: none`
или `hidden` оставили бы trigger без описания. Позиционирование использует тот же общий модуль,
что и `<mndw-select>`, экспортируя `computeTooltipCoords`; tooltip центрируется со стороны запроса,
переворачивается при обрезании этой стороны, ограничивает поперечную ось viewport и публикует
итоговую сторону как `data-placement` для стилей.

`<mndw-button>` использует `ElementInternals` только для доступа к содержащей форме:
`type="submit"` вызывает `requestSubmit()`, а `type="reset"` — `reset()`. Он не добавляет пару
name/value и не является нативным submitter; если нужны данные submitter, используйте нативный
`<button>`.

`variant` принимает `primary`, `secondary`, `ghost` или `danger`, default остаётся `secondary`.
`danger` предназначен для разрушающих действий — удаления плагина или забытого устройства — и
выводится как tint `--mndw-danger-bg` с text и border `--mndw-danger`, немного темнеющий при
hover. Это намеренно **не** сплошная danger-заливка: palette моделирует `danger` как foreground
и не генерирует для него contrast pair, поэтому solid fill был бы цветовой комбинацией, которую
generator никогда не проверял.

## Стилизация

Компоненты используют унаследованные токены `--mndw-*`. Для стилей компонентов используйте
`::part()`. Select panels портальны, поэтому `panel-class` должен быть глобальным и применяется
к wrapper слоя overlay:

```html

<mndw-select panel-class="tx-rx-iface-panel"></mndw-select>
```

```css
.tx-rx-iface-panel mndw-select-panel::part(option) {
  padding: 0.625rem;
}

.tx-rx-iface-panel mndw-select-panel::part(listbox) {
  padding-inline-end: 1.25rem;
}

.tx-rx-iface-panel mndw-select-panel::part(thumb) {
  background: var(--mndw-accent);
}
```

### Глобальный слой классов

Страницы хоста один раз импортируют `@mndw/sdk/tokens.css` и `@mndw/ui/styles.css`. Слой
классов стилизует содержимое light DOM без регистрации элементов:

```html

<div class="mndw-alert mndw-alert--danger" role="alert">
    <div class="mndw-alert__title">Connection failed</div>
    <div class="mndw-alert__body">Retry request.</div>
</div>
<span class="mndw-badge mndw-badge--success">Connected</span>
<span class="mndw-status-dot mndw-status-dot--success" aria-hidden="true"></span>
<span class="mndw-spinner" aria-hidden="true"></span>
<div class="mndw-progress" role="progressbar" aria-busy="true"></div>
```

Alerts, badges и status dots поддерживают модификаторы `--danger`, `--success`, `--warning` и
`--info`. `.mndw-empty`, `.mndw-card` и `.mndw-toolbar` — семантические containers; потребители
владеют headings, roles, names и семантикой live-region. `.mndw-spinner` и `.mndw-progress` не
добавляют roles. Для видимости используйте нативный `[hidden]`, а для runtime state — attributes,
например `[aria-busy]`.

Fields используют `.mndw-field` с `.mndw-field__label`, `.mndw-field__hint` и
`.mndw-field__error`. Потребитель владеет IDs control и связями `aria-describedby`/`aria-invalid`;
содержимое error получает `role="alert"`, когда прерывает работу пользователя. `<mndw-field>`
применяет те же classes к себе и своим nodes и выполняет эти связи за вас.

Tables используют `.mndw-table` с обычной разметкой `caption`, `thead`, `tbody`, `tr`, `th` и
`td`. Добавьте `.mndw-table--sticky-head`, чтобы включить липкий header. Состояние сортировки
выражается нативным `aria-sort`; runtime classes для состояния не нужны.

Wrapper overlay владеет ограничениями width и height; panel владеет визуальным chrome, а вложенный
`<mndw-scroll-area>` — прокруткой вариантов. Его parts `viewport`, `scrollbar`, `track` и `thumb`
передаются панелью select. Используйте `refresh()` для изменений содержимого, которые observers
не видят, или `viewportElement` для прямого доступа к нативным `scrollTop`/`scrollTo`.

Hooks scrollbar: `--mndw-scrollbar-size`, `--mndw-scrollbar-thumb`, `--mndw-scrollbar-thumb-hover`,
`--mndw-scrollbar-track`, `--mndw-scrollbar-radius` и `--mndw-scrollbar-thumb-min-size` (default
`1.5rem`). Generator выдаёт defaults; overrides предков корректно наследуются. Chrome scrollbar
имеет `aria-hidden`; нативные viewport и listbox остаются доступной поверхностью взаимодействия.

Если `ElementInternals.ariaControlsElements` недоступен, select не добавляет `aria-controls`,
поскольку его panel портален в другое дерево nodes. Богатые дочерние nodes option клонируются в
panel без интерполяции HTML-строк. Chrome sheet принадлежит overlay хоста и не предоставляется
через `::part()`.
