package stepkit

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

type Video struct {
	MimeType string `json:"mime_type"`
	Data     string `json:"data"`
}

func ExtractJSON(text string) (json.RawMessage, error) {
	s := strings.TrimSpace(text)
	if strings.HasPrefix(s, "```") {
		if nl := strings.IndexByte(s, '\n'); nl >= 0 {
			s = s[nl+1:]
		}
		s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "```"))
	}
	if !json.Valid([]byte(s)) {
		return nil, errors.New("输出不是合法 JSON，只能输出一个 JSON 对象，不要夹带解释文字")
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, []byte(s)); err != nil {
		return nil, errors.New("输出不是合法 JSON")
	}
	return buf.Bytes(), nil
}
