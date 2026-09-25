package plugin

import (
	"errors"
	"fmt"
	"strings"

	"github.com/google/go-jsonnet/ast"
	"github.com/google/go-jsonnet/formatter"
	"github.com/google/go-jsonnet/toolutils"
)

type jsonnetDashboardRepair struct {
	content string
	locals  map[string]ast.Node
}

type jsonnetDashboardExpression struct {
	replaceNode   ast.Node
	dashboardCall *ast.Apply
	panelsNode    ast.Node
}

const defaultVirtualJsonnetPath = "dashboard.jsonnet"

func normalizeSourceLineEndings(source string) string {
	return strings.ReplaceAll(strings.ReplaceAll(source, "\r\n", "\n"), "\r", "\n")
}

func repairJsonnetDashboardSource(source string) (string, []string, error) {
	content := normalizeSourceLineEndings(source)
	root, _, err := formatter.SnippetToRawAST(defaultVirtualJsonnetPath, content)
	if err != nil {
		return "", nil, fmt.Errorf("jsonnet must parse before structural repair can run: %w", err)
	}

	repair := jsonnetDashboardRepair{
		content: content,
		locals:  collectJsonnetLocalBinds(root),
	}
	dashboardExpression := repair.findDashboardExpression(root)
	if dashboardExpression == nil || dashboardExpression.dashboardCall == nil {
		return "", nil, errors.New("supported repair requires a g.dashboard.new(...) call")
	}

	dashboardObject, panelCount, err := repair.dashboardObject(*dashboardExpression)
	if err != nil {
		return "", nil, err
	}
	repaired, err := replaceJsonnetRange(content, dashboardExpression.replaceNode.Loc(), dashboardObject)
	if err != nil {
		return "", nil, err
	}

	repairs := []string{
		"rewrote the unsupported Grafonnet dashboard constructor chain into a plain dashboard object",
		fmt.Sprintf("converted %d panel constructor expressions into raw panel objects", panelCount),
		"converted target constructor calls into Prometheus target objects",
	}
	return repaired, repairs, nil
}

func (r jsonnetDashboardRepair) findDashboardExpression(node ast.Node) *jsonnetDashboardExpression {
	if node == nil {
		return nil
	}
	for _, child := range toolutils.Children(node) {
		if found := r.findDashboardExpression(child); found != nil {
			return found
		}
	}

	dashboardCall := findJsonnetApply(node, "g.dashboard.new")
	if dashboardCall == nil {
		return nil
	}
	args := jsonnetApplyArgs(dashboardCall)
	if panelsNode := args["panels"]; panelsNode != nil {
		return &jsonnetDashboardExpression{
			replaceNode:   dashboardCall,
			dashboardCall: dashboardCall,
			panelsNode:    panelsNode,
		}
	}

	withPanelsCall := findJsonnetApplyAny(node, "g.dashboard.with_panels", "g.dashboard.withPanels")
	if withPanelsCall == nil {
		return nil
	}
	panelsNode := firstJsonnetCallArg(withPanelsCall)
	if panelsNode == nil {
		return nil
	}
	return &jsonnetDashboardExpression{
		replaceNode:   node,
		dashboardCall: dashboardCall,
		panelsNode:    panelsNode,
	}
}

func (r jsonnetDashboardRepair) dashboardObject(expression jsonnetDashboardExpression) (string, int, error) {
	args := jsonnetApplyArgs(expression.dashboardCall)
	panelsNode := r.resolveJsonnetNode(expression.panelsNode)
	panelsArray, ok := panelsNode.(*ast.Array)
	if panelsNode == nil || !ok {
		return "", 0, errors.New("supported repair requires dashboard panels=[...] or dashboard.with_panels([...])")
	}

	panelObjects := make([]string, 0, len(panelsArray.Elements))
	for index, element := range panelsArray.Elements {
		panelObject, err := r.panelObject(element.Expr, index)
		if err != nil {
			return "", 0, err
		}
		panelObjects = append(panelObjects, panelObject)
	}

	var builder strings.Builder
	builder.WriteString("{\n")
	r.writeObjectField(&builder, 1, "title", firstJsonnetArgSource(r.content, args, "title", "0", "'Managed Dashboard'"))
	if uid := r.dashboardMixinArg(expression.replaceNode, args, "uid", "g.dashboard.withUid", "g.dashboard.with_uid"); uid != "" {
		r.writeObjectField(&builder, 1, "uid", uid)
	}
	if tags := r.dashboardMixinArg(expression.replaceNode, args, "tags", "g.dashboard.withTags", "g.dashboard.with_tags"); tags != "" {
		r.writeObjectField(&builder, 1, "tags", tags)
	}
	if timezone := r.dashboardMixinArg(expression.replaceNode, args, "timezone", "g.dashboard.withTimezone", "g.dashboard.with_timezone"); timezone != "" {
		r.writeObjectField(&builder, 1, "timezone", timezone)
	}
	if refresh := r.dashboardMixinArg(expression.replaceNode, args, "refresh", "g.dashboard.withRefresh", "g.dashboard.with_refresh"); refresh != "" {
		r.writeObjectField(&builder, 1, "refresh", refresh)
	}
	r.writeObjectField(&builder, 1, "schemaVersion", "39")
	builder.WriteString("  panels: [\n")
	for index, panel := range panelObjects {
		builder.WriteString(indentJsonnet(panel, 2))
		if index < len(panelObjects)-1 {
			builder.WriteString(",")
		}
		builder.WriteString("\n")
	}
	builder.WriteString("  ],\n")
	builder.WriteString("}")
	return builder.String(), len(panelObjects), nil
}

func (r jsonnetDashboardRepair) dashboardMixinArg(node ast.Node, args map[string]ast.Node, argName string, mixinPaths ...string) string {
	if value := jsonnetNodeSource(r.content, args[argName]); value != "" {
		return value
	}
	for _, path := range mixinPaths {
		if call := findJsonnetApply(node, path); call != nil {
			if value := jsonnetNodeSource(r.content, firstJsonnetCallArg(call)); value != "" {
				return value
			}
		}
	}
	return ""
}

func (r jsonnetDashboardRepair) panelObject(node ast.Node, index int) (string, error) {
	node = r.resolveJsonnetNode(node)
	call, panelType := findJsonnetPanelConstructor(node)
	if call == nil {
		return "", fmt.Errorf("unsupported panel expression near %s: expected a known panel constructor", jsonnetLocationString(node))
	}
	args := jsonnetApplyArgs(call)
	panelDatasource := r.datasourceObject(args["datasource"])
	targets, err := r.panelTargets(args["targets"], panelDatasource)
	if err != nil {
		return "", err
	}

	if explicitType := jsonnetNodeSource(r.content, args["type"]); explicitType != "" {
		panelType = explicitType
	}
	datasource := firstNonEmpty(panelDatasource, firstTargetDatasource(targets))

	var builder strings.Builder
	builder.WriteString("{\n")
	r.writeObjectField(&builder, 1, "title", firstJsonnetArgSource(r.content, args, "title", "0", "'Untitled panel'"))
	if id := jsonnetNodeSource(r.content, args["id"]); id != "" {
		r.writeObjectField(&builder, 1, "id", id)
	}
	r.writeObjectField(&builder, 1, "type", panelType)
	if gridPos := r.gridPosObject(args["gridPos"]); gridPos != "" {
		r.writeObjectField(&builder, 1, "gridPos", gridPos)
	} else {
		r.writeObjectField(&builder, 1, "gridPos", r.defaultGridPosObject(index, args["span"]))
	}
	if datasource != "" {
		r.writeObjectField(&builder, 1, "datasource", datasource)
	}
	if unit := firstNonEmpty(r.fieldUnit(args["fieldConfigDefaults"]), r.fieldUnit(args["fieldConfig"])); unit != "" {
		builder.WriteString("  fieldConfig: { defaults: { unit: ")
		builder.WriteString(unit)
		builder.WriteString(" }, overrides: [] },\n")
	}
	if len(targets) > 0 {
		builder.WriteString("  targets: [\n")
		for index, target := range targets {
			builder.WriteString(indentJsonnet(target.object, 2))
			if index < len(targets)-1 {
				builder.WriteString(",")
			}
			builder.WriteString("\n")
		}
		builder.WriteString("  ],\n")
	}
	builder.WriteString("}")
	return builder.String(), nil
}

type repairedTarget struct {
	object     string
	datasource string
}

func (r jsonnetDashboardRepair) panelTargets(node ast.Node, defaultDatasource string) ([]repairedTarget, error) {
	array, ok := r.resolveJsonnetNode(node).(*ast.Array)
	if node == nil || !ok {
		return nil, nil
	}
	targets := make([]repairedTarget, 0, len(array.Elements))
	for _, element := range array.Elements {
		target, err := r.targetObject(element.Expr, defaultDatasource)
		if err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	return targets, nil
}

func (r jsonnetDashboardRepair) targetObject(node ast.Node, defaultDatasource string) (repairedTarget, error) {
	node = r.resolveJsonnetNode(node)
	call := findJsonnetApply(node, "g.target.new")
	if call == nil {
		return repairedTarget{}, fmt.Errorf("unsupported target expression near %s: expected g.target.new(...)", jsonnetLocationString(node))
	}
	args := jsonnetApplyArgs(call)
	datasource := firstNonEmpty(r.datasourceObject(args["datasource"]), defaultDatasource)
	if datasource == "" {
		datasource = "{ type: 'prometheus', uid: 'prometheus' }"
	}

	var builder strings.Builder
	builder.WriteString("{\n")
	r.writeObjectField(&builder, 1, "datasource", datasource)
	if expr := jsonnetNodeSource(r.content, args["expr"]); expr != "" {
		r.writeObjectField(&builder, 1, "expr", expr)
	}
	r.writeObjectField(&builder, 1, "refId", firstJsonnetArgSource(r.content, args, "refId", "0", "'A'"))
	if legend := firstNonEmpty(jsonnetNodeSource(r.content, args["legendFormat"]), jsonnetNodeSource(r.content, args["legend"])); legend != "" {
		r.writeObjectField(&builder, 1, "legendFormat", legend)
	}
	builder.WriteString("  range: true,\n")
	builder.WriteString("  editorMode: 'code',\n")
	builder.WriteString("}")
	return repairedTarget{object: builder.String(), datasource: datasource}, nil
}

func (r jsonnetDashboardRepair) defaultGridPosObject(index int, spanNode ast.Node) string {
	width := jsonnetNodeSource(r.content, spanNode)
	if strings.TrimSpace(width) == "" {
		width = "24"
	}
	return fmt.Sprintf("{ x: 0, y: %d, w: %s, h: 8 }", index*8, width)
}

func (r jsonnetDashboardRepair) gridPosObject(node ast.Node) string {
	call, ok := node.(*ast.Apply)
	if node == nil || !ok {
		return jsonnetNodeSource(r.content, node)
	}
	pathName, ok := jsonnetDottedPath(call.Target)
	if !ok || pathName != "g.gridPos.to_val" {
		return jsonnetNodeSource(r.content, node)
	}
	args := jsonnetApplyArgs(call)
	fields := []string{}
	for _, name := range []string{"x", "y", "w", "h"} {
		value := jsonnetNodeSource(r.content, args[name])
		if value != "" {
			fields = append(fields, fmt.Sprintf("%s: %s", name, value))
		}
	}
	if len(fields) == 0 {
		return ""
	}
	return "{ " + strings.Join(fields, ", ") + " }"
}

func (r jsonnetDashboardRepair) datasourceObject(node ast.Node) string {
	node = r.resolveJsonnetNode(node)
	if node == nil {
		return ""
	}
	if _, ok := node.(*ast.Object); ok {
		return jsonnetNodeSource(r.content, node)
	}
	if _, ok := node.(*ast.LiteralString); ok {
		value := jsonnetNodeSource(r.content, node)
		return fmt.Sprintf("{ type: 'prometheus', uid: %s }", value)
	}
	if call, ok := node.(*ast.Apply); ok {
		pathName, ok := jsonnetDottedPath(call.Target)
		if ok && (strings.HasSuffix(pathName, ".defaultDatasource") || strings.HasSuffix(pathName, ".default_datasource")) {
			args := jsonnetApplyArgs(call)
			uid := firstJsonnetArgSource(r.content, args, "uid", "0", "'prometheus'")
			return fmt.Sprintf("{ type: 'prometheus', uid: %s }", uid)
		}
	}
	return jsonnetNodeSource(r.content, node)
}

func (r jsonnetDashboardRepair) fieldUnit(node ast.Node) string {
	call, ok := node.(*ast.Apply)
	if node == nil || !ok {
		return ""
	}
	pathName, ok := jsonnetDottedPath(call.Target)
	if !ok {
		return ""
	}
	if pathName == "g.panel.fieldConfig.defaults" {
		args := jsonnetApplyArgs(call)
		return jsonnetNodeSource(r.content, args["unit"])
	}
	if !strings.HasSuffix(pathName, ".setUnit") && !strings.HasSuffix(pathName, ".withUnit") && !strings.HasSuffix(pathName, ".with_unit") {
		return ""
	}
	if len(call.Arguments.Positional) == 0 {
		return ""
	}
	return jsonnetNodeSource(r.content, call.Arguments.Positional[0].Expr)
}

func (r jsonnetDashboardRepair) resolveJsonnetNode(node ast.Node) ast.Node {
	return r.resolveJsonnetNodeSeen(node, map[string]bool{})
}

func (r jsonnetDashboardRepair) resolveJsonnetNodeSeen(node ast.Node, seen map[string]bool) ast.Node {
	switch typed := node.(type) {
	case *ast.Var:
		name := string(typed.Id)
		if seen[name] {
			return node
		}
		if resolved := r.locals[name]; resolved != nil {
			seen[name] = true
			return r.resolveJsonnetNodeSeen(resolved, seen)
		}
	case *ast.Parens:
		return r.resolveJsonnetNodeSeen(typed.Inner, seen)
	}
	return node
}

func (r jsonnetDashboardRepair) writeObjectField(builder *strings.Builder, indent int, name, value string) {
	if strings.TrimSpace(value) == "" {
		return
	}
	builder.WriteString(strings.Repeat("  ", indent))
	builder.WriteString(name)
	builder.WriteString(": ")
	builder.WriteString(value)
	builder.WriteString(",\n")
}

func jsonnetApplyArgs(call *ast.Apply) map[string]ast.Node {
	result := map[string]ast.Node{}
	for index, arg := range call.Arguments.Positional {
		result[fmt.Sprintf("%d", index)] = arg.Expr
	}
	for _, arg := range call.Arguments.Named {
		result[string(arg.Name)] = arg.Arg
	}
	return result
}

func firstJsonnetCallArg(call *ast.Apply) ast.Node {
	if call == nil || len(call.Arguments.Positional) == 0 {
		return nil
	}
	return call.Arguments.Positional[0].Expr
}

func firstJsonnetArgSource(source string, args map[string]ast.Node, names ...string) string {
	fallback := ""
	if len(names) > 0 {
		fallback = names[len(names)-1]
		names = names[:len(names)-1]
	}
	for _, name := range names {
		if value := jsonnetNodeSource(source, args[name]); value != "" {
			return value
		}
	}
	return fallback
}

func firstTargetDatasource(targets []repairedTarget) string {
	for _, target := range targets {
		if target.datasource != "" {
			return target.datasource
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func collectJsonnetLocalBinds(node ast.Node) map[string]ast.Node {
	binds := map[string]ast.Node{}
	collectJsonnetLocalBindsInto(node, binds)
	return binds
}

func collectJsonnetLocalBindsInto(node ast.Node, binds map[string]ast.Node) {
	if node == nil {
		return
	}
	if local, ok := node.(*ast.Local); ok {
		for _, bind := range local.Binds {
			binds[string(bind.Variable)] = bind.Body
		}
	}
	for _, child := range toolutils.Children(node) {
		collectJsonnetLocalBindsInto(child, binds)
	}
}

func findJsonnetApply(node ast.Node, expectedPath string) *ast.Apply {
	if node == nil {
		return nil
	}
	if apply, ok := node.(*ast.Apply); ok {
		if pathName, ok := jsonnetDottedPath(apply.Target); ok && pathName == expectedPath {
			return apply
		}
	}
	for _, child := range toolutils.Children(node) {
		if found := findJsonnetApply(child, expectedPath); found != nil {
			return found
		}
	}
	return nil
}

func findJsonnetApplyAny(node ast.Node, expectedPaths ...string) *ast.Apply {
	if node == nil {
		return nil
	}
	if apply, ok := node.(*ast.Apply); ok {
		if pathName, ok := jsonnetDottedPath(apply.Target); ok {
			for _, expectedPath := range expectedPaths {
				if pathName == expectedPath {
					return apply
				}
			}
		}
	}
	for _, child := range toolutils.Children(node) {
		if found := findJsonnetApplyAny(child, expectedPaths...); found != nil {
			return found
		}
	}
	return nil
}

func findJsonnetPanelConstructor(node ast.Node) (*ast.Apply, string) {
	if node == nil {
		return nil, ""
	}
	if apply, ok := node.(*ast.Apply); ok {
		if panelType, ok := jsonnetPanelConstructorType(apply); ok {
			return apply, panelType
		}
	}
	for _, child := range toolutils.Children(node) {
		if call, panelType := findJsonnetPanelConstructor(child); call != nil {
			return call, panelType
		}
	}
	return nil, ""
}

func jsonnetPanelConstructorType(call *ast.Apply) (string, bool) {
	pathName, ok := jsonnetDottedPath(call.Target)
	if !ok || !strings.HasSuffix(pathName, ".new") {
		return "", false
	}
	normalized := strings.ToLower(strings.ReplaceAll(pathName, "_", ""))
	switch {
	case normalized == "g.panel.new":
		return "'timeseries'", true
	case strings.Contains(normalized, "timeseries"):
		return "'timeseries'", true
	case strings.Contains(normalized, "statpanel") || strings.Contains(normalized, ".stat."):
		return "'stat'", true
	case strings.Contains(normalized, "gaugepanel") || strings.Contains(normalized, ".gauge."):
		return "'gauge'", true
	case strings.Contains(normalized, "tablepanel") || strings.Contains(normalized, ".table."):
		return "'table'", true
	case strings.Contains(normalized, "rowpanel") || strings.Contains(normalized, ".row."):
		return "'row'", true
	default:
		return "", false
	}
}

func jsonnetDottedPath(node ast.Node) (string, bool) {
	switch typed := node.(type) {
	case *ast.Var:
		return string(typed.Id), true
	case *ast.Index:
		if typed.Id == nil {
			return "", false
		}
		prefix, ok := jsonnetDottedPath(typed.Target)
		if !ok {
			return "", false
		}
		return prefix + "." + string(*typed.Id), true
	case *ast.Parens:
		return jsonnetDottedPath(typed.Inner)
	default:
		return "", false
	}
}

func jsonnetNodeSource(source string, node ast.Node) string {
	if node == nil || node.Loc() == nil || !node.Loc().IsSet() {
		return ""
	}
	snippet, err := jsonnetRangeSource(source, node.Loc())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(snippet)
}

func jsonnetRangeSource(source string, loc *ast.LocationRange) (string, error) {
	start, end, err := jsonnetRangeOffsets(source, loc)
	if err != nil {
		return "", err
	}
	return source[start:end], nil
}

func replaceJsonnetRange(source string, loc *ast.LocationRange, replacement string) (string, error) {
	start, end, err := jsonnetRangeOffsets(source, loc)
	if err != nil {
		return "", err
	}
	return source[:start] + replacement + source[end:], nil
}

func jsonnetRangeOffsets(source string, loc *ast.LocationRange) (int, int, error) {
	if loc == nil || !loc.IsSet() {
		return 0, 0, errors.New("jsonnet AST node has no source range")
	}
	start, err := jsonnetLocationOffset(source, loc.Begin)
	if err != nil {
		return 0, 0, err
	}
	end, err := jsonnetLocationOffset(source, loc.End)
	if err != nil {
		return 0, 0, err
	}
	if start > end || end > len(source) {
		return 0, 0, fmt.Errorf("invalid Jsonnet source range %d-%d", start, end)
	}
	return start, end, nil
}

func jsonnetLocationOffset(source string, loc ast.Location) (int, error) {
	if loc.Line < 1 || loc.Column < 1 {
		return 0, fmt.Errorf("invalid Jsonnet source location %d:%d", loc.Line, loc.Column)
	}
	line := 1
	offset := 0
	for offset < len(source) && line < loc.Line {
		if source[offset] == '\n' {
			line++
		}
		offset++
	}
	if line != loc.Line {
		return 0, fmt.Errorf("jsonnet source line %d is out of range", loc.Line)
	}
	columnOffset := loc.Column - 1
	lineEnd := offset
	for lineEnd < len(source) && source[lineEnd] != '\n' {
		lineEnd++
	}
	if offset+columnOffset > lineEnd {
		return 0, fmt.Errorf("jsonnet source column %d is out of range on line %d", loc.Column, loc.Line)
	}
	return offset + columnOffset, nil
}

func jsonnetLocationString(node ast.Node) string {
	if node == nil || node.Loc() == nil {
		return "unknown location"
	}
	return node.Loc().String()
}

func indentJsonnet(source string, levels int) string {
	prefix := strings.Repeat("  ", levels)
	lines := strings.Split(source, "\n")
	for index, line := range lines {
		if strings.TrimSpace(line) != "" {
			lines[index] = prefix + line
		}
	}
	return strings.Join(lines, "\n")
}
