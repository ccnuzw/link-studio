package dramaoutput

import "unicode/utf8"

type AnalyzeOutput struct {
	SourceKind   string `json:"source_kind"`
	Summary      string `json:"summary"`
	CharactersMD string `json:"characters_md"`
	OutlineMD    string `json:"outline_md"`
}

func (o AnalyzeOutput) Validate() error {
	if o.SourceKind != "script" && o.SourceKind != "novel" {
		return invalidOutput("source_kind 必须为 script 或 novel")
	}
	if !nonemptyText(o.Summary) || !nonemptyText(o.CharactersMD) || !nonemptyText(o.OutlineMD) {
		return invalidOutput("summary、characters_md 与 outline_md 必须为非空文本")
	}
	return nil
}

type PlanEpisode struct {
	Title       string `json:"title"`
	Synopsis    string `json:"synopsis"`
	Hook        string `json:"hook"`
	Cliffhanger string `json:"cliffhanger"`
	UnitFrom    int    `json:"unit_from"`
	UnitTo      int    `json:"unit_to"`
	ScriptMD    string `json:"-"`
}

// PlanOutput 是一次最多六十集的批次规划。
type PlanOutput struct {
	Episodes []PlanEpisode `json:"episodes"`
}

// Validate 校验规划基本结构；范围由 ValidateCoverage 对照任务校验。
func (o PlanOutput) Validate() error {
	if len(o.Episodes) < 1 || len(o.Episodes) > 60 {
		return invalidOutput("每批须包含 1–60 集")
	}
	for _, e := range o.Episodes {
		if !nonemptyText(e.Title) || utf8.RuneCountInString(e.Title) > 255 || !nonemptyText(e.Synopsis) || !nonemptyText(e.Hook) || !nonemptyText(e.Cliffhanger) || e.UnitFrom < 1 || e.UnitTo < e.UnitFrom {
			return invalidOutput("规划标题、梗概、钩子、悬念和单元区间无效")
		}
	}
	return nil
}

// ValidateCoverage 允许同单元跨集，拒绝跳单元、倒序和超出批次范围。
func (o PlanOutput) ValidateCoverage(from, to int) error {
	if err := o.Validate(); err != nil {
		return err
	}
	cursor := from
	for i, e := range o.Episodes {
		if i == 0 && e.UnitFrom != from || e.UnitFrom < cursor || e.UnitFrom > cursor+1 || e.UnitTo > to {
			return invalidOutput("规划必须按序连续覆盖本批全部单元")
		}
		cursor = e.UnitTo
	}
	if cursor != to {
		return invalidOutput("规划未覆盖批次末尾")
	}
	return nil
}
