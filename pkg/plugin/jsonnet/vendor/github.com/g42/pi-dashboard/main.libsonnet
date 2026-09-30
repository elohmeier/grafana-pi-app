local refIds = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
];

local has(object, field) = std.objectHas(object, field);
local ceilDiv(value, divisor) = std.floor((value + divisor - 1) / divisor);
local range(length) = if length <= 0 then [] else std.range(0, length - 1);
local sum(values) = std.foldl(function(total, value) total + value, values, 0);
local datasource(uid) = { type: 'prometheus', uid: uid };
local withField(object, field, value) = if value == null then object else object + { [field]: value };

local assignTargetRefs(targets) = [
  targets[index] + {
    refId: if has(targets[index], 'refId') && targets[index].refId != null
    then targets[index].refId
    else refIds[index],
  }
  for index in range(std.length(targets))
];

local panelBase(type, title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={}) =
  local assignedTargets = assignTargetRefs(targets);
  {
    title: title,
    type: type,
    datasource: datasource(datasourceUid),
    targets: assignedTargets,
    fieldConfig: {
      defaults: withField(withField({}, 'unit', unit), 'decimals', decimals) + (if has(fieldConfig, 'defaults') then fieldConfig.defaults else {}),
      overrides: if has(fieldConfig, 'overrides') then fieldConfig.overrides else [],
    },
    options: options,
  };

local group(panels, height) = { panels: panels, height: height };
local layoutFull(panel, h=8) = group([panel + { gridPos: { x: 0, y: 0, w: 24, h: h } }], h);
local layoutTwoUp(panels, h=8) = group([
  panels[index] + { gridPos: { x: (index % 2) * 12, y: std.floor(index / 2) * h, w: 12, h: h } }
  for index in range(std.length(panels))
], ceilDiv(std.length(panels), 2) * h);
local layoutThreeUp(panels, h=8) = group([
  panels[index] + { gridPos: { x: (index % 3) * 8, y: std.floor(index / 3) * h, w: 8, h: h } }
  for index in range(std.length(panels))
], ceilDiv(std.length(panels), 3) * h);
local layoutFourUp(panels, h=8) = group([
  panels[index] + { gridPos: { x: (index % 4) * 6, y: std.floor(index / 4) * h, w: 6, h: h } }
  for index in range(std.length(panels))
], ceilDiv(std.length(panels), 4) * h);
local asGroup(value) = if std.isObject(value) && has(value, 'panels') && has(value, 'height') then value else layoutFull(value);
local shiftPanel(panel, dy) = panel + { gridPos: panel.gridPos + { y: panel.gridPos.y + dy } };
local rowGroupY(groups, index) = sum([groups[groupIndex].height for groupIndex in range(index)]);
local rowHeight(groups) = 1 + sum([group.height for group in groups]);

local rowContentPanels(groups) = std.flattenArrays([
  [shiftPanel(panel, 1 + rowGroupY(groups, groupIndex)) for panel in groups[groupIndex].panels]
  for groupIndex in range(std.length(groups))
]);

local shiftRowPanel(panel, dy) = panel + { gridPos: panel.gridPos + { y: panel.gridPos.y + dy } };
// A d.row(...) result has a title; anything else (a d.layout.* group or a bare panel) is a section without a row header.
local isRow(value) = std.isObject(value) && has(value, 'title') && has(value, 'panels') && has(value, 'height') && !has(value, 'type');
local section(value) =
  if isRow(value) then value + { header: true, collapsed: if has(value, 'collapsed') then value.collapsed else false }
  else asGroup(value) + { header: false, collapsed: false };
local expandedRowPanels(row, rowY) =
  local rowPanel = {
    title: row.title,
    type: 'row',
    collapsed: row.collapsed,
    gridPos: { x: 0, y: rowY, w: 24, h: 1 },
  };
  if !row.header then [shiftRowPanel(panel, rowY) for panel in row.panels]
  else if row.collapsed then [rowPanel + { panels: [shiftRowPanel(panel, rowY) for panel in row.panels] }]
  else [rowPanel] + [shiftRowPanel(panel, rowY) for panel in row.panels];

local rowY(rows, index) = sum([rows[rowIndex].height for rowIndex in range(index)]);
local withPanelIds(panels) = [
  panels[index] + {
    id: if has(panels[index], 'id') && panels[index].id != null then panels[index].id else index + 1,
  }
  for index in range(std.length(panels))
];
local tableLabelsToFields() = { id: 'labelsToFields', options: { mode: 'columns' } };
local tableFilterFields(names) = { id: 'filterFieldsByName', options: { include: { names: names } } };
local tableOrganize(order, rename={}) = {
  id: 'organize',
  options: {
    indexByName: { [order[index]]: index for index in range(std.length(order)) },
    renameByName: rename,
  },
};
local slugifyTitle(title) =
  local lower = std.asciiLower(title);
  local replaced = std.foldl(
    function(text, char) std.strReplace(text, char, '-'),
    [' ', '&', '/', '\\', ':', '.', ',', '(', ')', '[', ']', '{', '}', '|'],
    lower
  );
  std.strReplace(std.strReplace(replaced, '--', '-'), '--', '-');
// current may be a string or, for multi-value variables, an array of strings.
local currentValue(current) = if current == null then null else { text: current, value: current };
local queryVariable(name, query='', datasourceUid=null, label=null, includeAll=false, multi=false, current=null, refresh=1, allValue=null) =
  withField(
    withField(
      {
        type: 'query',
        name: name,
        label: if label == null then name else label,
        query: query,
        definition: query,
        includeAll: includeAll,
        multi: multi,
        refresh: refresh,
        current: currentValue(current),
      },
      'datasource',
      if datasourceUid == null then null else datasource(datasourceUid)
    ),
    'allValue',
    allValue
  );
local splitValues(values) =
  if std.isString(values) then [std.stripChars(value, ' ') for value in std.split(values, ',') if std.stripChars(value, ' ') != '']
  else values;
local customVariable(name, values, current=null, label=null, multi=false, includeAll=false, allValue=null) =
  local list = splitValues(values);
  local selected = if current != null then current
  else if std.length(list) == 0 then null
  else if multi then [list[0]]
  else list[0];
  local isSelected(value) = if std.isArray(selected) then std.member(selected, value) else value == selected;
  withField(
    {
      type: 'custom',
      name: name,
      label: if label == null then name else label,
      query: std.join(',', list),
      multi: multi,
      includeAll: includeAll,
      current: currentValue(selected),
      options: [{ text: value, value: value, selected: isSelected(value) } for value in list],
    },
    'allValue',
    allValue
  );
// Accepts a variable list or a { list: [...] } templating object.
local variableList(value) =
  if value == null then []
  else if std.isArray(value) then value
  else if std.isObject(value) && has(value, 'list') then value.list
  else error 'templating must be a list of variables or { list: [...] }';

{
  dashboard: {
    // rows: d.row(...) results; d.layout.* groups and bare panels become sections without a row header.
    // panels: panels or d.layout.* groups placed above the rows without a row header.
    // variables: d.variable.* constructors; templating is accepted as an alias.
    // The result also has chainable withVariables([...]) / withTemplating([...]) methods.
    new(title, uid=null, tags=[], timezone='browser', time={ from: 'now-6h', to: 'now' }, refresh='30s', rows=[], variables=[], templating=null, panels=[]):: (
      local sections = [section(value) for value in panels + rows];
      local expandedRows = [expandedRowPanels(sections[index], rowY(sections, index)) for index in range(std.length(sections))];
      local allVariables = variableList(variables) + variableList(templating);
      {
        title: title,
        uid: if uid == null || uid == '' then slugifyTitle(title) else uid,
        tags: tags,
        timezone: timezone,
        time: time,
        refresh: refresh,
        schemaVersion: 39,
        panels: withPanelIds(std.flattenArrays(expandedRows)),
        withVariables(list):: self + {
          local existing = if 'templating' in super then super.templating.list else [],
          templating: { list: existing + variableList(list) },
        },
        withTemplating(list):: self.withVariables(list),
        with_templating(list):: self.withVariables(list),
        with_variables(list):: self.withVariables(list),
      } + (if std.length(allVariables) > 0 then { templating: { list: allVariables } } else {})
    ),

    with_time_range(from='now-6h', to='now'):: { time: { from: from, to: to } },
    withTimeRange(from='now-6h', to='now'):: self.with_time_range(from, to),

    with_tags(tags):: { tags: tags },
    withTags(tags):: self.with_tags(tags),

    with_timezone(timezone='browser'):: { timezone: timezone },
    withTimezone(timezone='browser'):: self.with_timezone(timezone),

    with_templating(list):: { templating: { list: variableList(list) } },
    withTemplating(list):: self.with_templating(list),
    withtemplating(list):: self.with_templating(list),
    with_template(list):: self.with_templating(list),
    with_variables(list):: self.with_templating(list),
  },

  row(title, panels, collapsed=false):: (
    local groups = [asGroup(panelOrGroup) for panelOrGroup in panels];
    {
      title: title,
      collapsed: collapsed,
      height: rowHeight(groups),
      panels: rowContentPanels(groups),
    }
  ),

  layout: {
    full(panel, h=8):: layoutFull(panel, h=h),

    twoUp(panels, h=8):: layoutTwoUp(panels, h=h),

    threeUp(panels, h=8):: layoutThreeUp(panels, h=h),

    fourUp(panels, h=8):: layoutFourUp(panels, h=h),

    statStrip(panels, h=4):: layoutFourUp(panels, h=h),
  },

  prom: {
    datasource(uid):: datasource(uid),

    // legendFormat is accepted as an alias for legend.
    query(expr, datasourceUid, refId=null, legend='', instant=false, format='time_series', legendFormat=null):: (
      local base = {
        datasource: datasource(datasourceUid),
        expr: expr,
        instant: instant,
        range: !instant,
        format: format,
        editorMode: 'code',
      };
      local legendText = if legendFormat != null then legendFormat else legend;
      withField(withField(base, 'refId', refId), 'legendFormat', if legendText == '' then null else legendText)
    ),
  },

  table: {
    labelsToFields():: tableLabelsToFields(),

    filterFields(names):: tableFilterFields(names),

    organize(order, rename={}):: tableOrganize(order, rename),
  },

  templating: {
    list: {
      new(name, datasourceUid=null, query='', label=null, includeAll=false, multi=false, current=null, refresh=1, allValue=null)::
        queryVariable(name, query, datasourceUid, label, includeAll, multi, current, refresh, allValue),
    },
  },

  variable: {
    query(name, query='', datasourceUid=null, label=null, includeAll=false, multi=false, current=null, refresh=1, allValue=null)::
      queryVariable(name, query, datasourceUid, label, includeAll, multi, current, refresh, allValue),

    // Values from a label: label_values(metric, label), or label_values(label) without a metric.
    // Refreshes on time range change so values follow the selected range.
    labelValues(name, label, metric=null, datasourceUid=null, displayLabel=null, includeAll=false, multi=false, current=null, allValue=null)::
      queryVariable(
        name,
        if metric == null then 'label_values(%s)' % label else 'label_values(%s, %s)' % [metric, label],
        datasourceUid,
        displayLabel,
        includeAll,
        multi,
        current,
        2,
        allValue
      ),

    // Fixed values: an array of strings or a comma-separated string. current defaults to the first value.
    custom(name, values, current=null, label=null, multi=false, includeAll=false, allValue=null)::
      customVariable(name, values, current, label, multi, includeAll, allValue),

    constant(name, value)::
      { type: 'constant', name: name, hide: 2, query: value, current: currentValue(value) },

    textbox(name, value='', label=null)::
      {
        type: 'textbox',
        name: name,
        label: if label == null then name else label,
        query: value,
        current: currentValue(value),
      },

    datasource(name='datasource', type='prometheus', label=null, current=null)::
      {
        type: 'datasource',
        name: name,
        label: if label == null then name else label,
        query: type,
        current: if current == null then null else { text: current, value: current },
      },
  },

  panel: {
    timeseries(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={}):: (
      panelBase('timeseries', title, datasourceUid, targets, unit, decimals, options, fieldConfig)
    ),

    stat(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={}):: (
      panelBase('stat', title, datasourceUid, targets, unit, decimals, options, fieldConfig)
    ),

    table(title, datasourceUid, targets=[], columns=[], rename={}, transformations=[], unit=null, decimals=null, options={}, fieldConfig={}):: (
      local controlledTransforms =
        if std.length(columns) == 0 then []
        else [tableLabelsToFields(), tableFilterFields(columns), tableOrganize(columns, rename)];
      panelBase('table', title, datasourceUid, targets, unit, decimals, options, fieldConfig) + {
        transformations: controlledTransforms + transformations,
      }
    ),

    // Horizontal bars per series, e.g. top-N or shares from instant queries.
    bargauge(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={}):: (
      panelBase('bargauge', title, datasourceUid, targets, unit, decimals, {
        orientation: 'horizontal',
        displayMode: 'gradient',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      } + options, fieldConfig)
    ),

    // Shares of a whole, e.g. one instant query grouped by the split label.
    piechart(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={}):: (
      panelBase('piechart', title, datasourceUid, targets, unit, decimals, {
        pieType: 'pie',
        legend: { displayMode: 'table', placement: 'right', values: ['value', 'percent'] },
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      } + options, fieldConfig)
    ),

    // Markdown notes such as data caveats; no queries.
    text(title, content, mode='markdown'):: {
      title: title,
      type: 'text',
      options: { mode: mode, content: content },
    },
  },
}
