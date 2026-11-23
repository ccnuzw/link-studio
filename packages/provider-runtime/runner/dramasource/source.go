package dramasource

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

const MaxSourceRunes = 5_000_000

var ErrSourceInvalid = errors.New("原文格式不支持或内容为空")

var ErrSourceTooLong = errors.New("原文超过 500 万字")

func ParseSource(filename string, data []byte) (string, error) {
	var source string
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".txt", ".md":
		if !utf8.Valid(data) {
			return "", fmt.Errorf("%w：文本必须使用 UTF-8 编码", ErrSourceInvalid)
		}
		source = string(data)
	case ".docx":
		var err error
		source, err = parseDocx(data)
		if err != nil {
			return "", err
		}
	default:
		return "", fmt.Errorf("%w：仅支持 txt、md、docx", ErrSourceInvalid)
	}

	source = strings.TrimSpace(strings.TrimPrefix(source, "\ufeff"))
	source = strings.ReplaceAll(strings.ReplaceAll(source, "\r\n", "\n"), "\r", "\n")
	if source == "" {
		return "", fmt.Errorf("%w：没有可读取的正文", ErrSourceInvalid)
	}
	if utf8.RuneCountInString(source) > MaxSourceRunes {
		return "", ErrSourceTooLong
	}
	for _, r := range source {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return "", fmt.Errorf("%w：正文包含非文本控制字符", ErrSourceInvalid)
		}
	}
	return source, nil
}

func parseDocx(data []byte) (string, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("%w：无法读取 docx 压缩包", ErrSourceInvalid)
	}
	var document *zip.File
	for _, file := range archive.File {
		if file.Name != "word/document.xml" {
			continue
		}
		if document != nil {
			return "", fmt.Errorf("%w：docx 正文重复", ErrSourceInvalid)
		}
		document = file
	}
	if document == nil {
		return "", fmt.Errorf("%w：docx 缺少 word/document.xml", ErrSourceInvalid)
	}
	if document.UncompressedSize64 > 64<<20 {
		return "", fmt.Errorf("%w：docx 正文 XML 过大", ErrSourceInvalid)
	}
	reader, err := document.Open()
	if err != nil {
		return "", fmt.Errorf("%w：无法打开 docx 正文", ErrSourceInvalid)
	}
	defer reader.Close()

	return readDocxBody(reader)
}

type docxBody struct {
	text           strings.Builder
	depth          int
	bodyDepth      int
	paragraphDepth int
	textDepth      int
	seenRoot       bool
	seenBody       bool
}

func readDocxBody(reader io.Reader) (string, error) {
	decoder := xml.NewDecoder(reader)
	var body docxBody
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("%w：docx 正文 XML 无法解析", ErrSourceInvalid)
		}
		if err = body.consume(token); err != nil {
			return "", err
		}
	}
	if !body.seenRoot || !body.seenBody || body.depth != 0 {
		return "", fmt.Errorf("%w：docx 缺少有效正文", ErrSourceInvalid)
	}
	return body.text.String(), nil
}

func (b *docxBody) consume(token xml.Token) error {
	switch element := token.(type) {
	case xml.StartElement:
		return b.start(element.Name)
	case xml.CharData:
		if b.textDepth > 0 {
			b.text.Write(element)
		} else if b.depth == 0 && strings.TrimSpace(string(element)) != "" {
			return fmt.Errorf("%w：docx 正文根节点外存在文本", ErrSourceInvalid)
		}
	case xml.EndElement:
		if b.depth == b.textDepth {
			b.textDepth = 0
		}
		if b.depth == b.paragraphDepth {
			b.text.WriteByte('\n')
			b.paragraphDepth = 0
		}
		if b.depth == b.bodyDepth {
			b.bodyDepth = 0
		}
		b.depth--
	}
	return nil
}

func (b *docxBody) start(name xml.Name) error {
	b.depth++
	if b.depth == 1 {
		if b.seenRoot || !wordElement(name, "document") {
			return fmt.Errorf("%w：docx 正文根节点无效", ErrSourceInvalid)
		}
		b.seenRoot = true
	}
	if b.depth == 2 && wordElement(name, "body") {
		if b.seenBody {
			return fmt.Errorf("%w：docx 正文 body 重复", ErrSourceInvalid)
		}
		b.seenBody, b.bodyDepth = true, b.depth
	}
	if b.bodyDepth > 0 && wordElement(name, "p") && b.paragraphDepth == 0 {
		b.paragraphDepth = b.depth
	}
	if b.paragraphDepth > 0 && wordElement(name, "t") {
		b.textDepth = b.depth
	}
	return nil
}

func wordElement(name xml.Name, local string) bool {
	return name.Local == local && (name.Space == "http://schemas.openxmlformats.org/wordprocessingml/2006/main" ||
		name.Space == "http://purl.oclc.org/ooxml/wordprocessingml/main")
}
