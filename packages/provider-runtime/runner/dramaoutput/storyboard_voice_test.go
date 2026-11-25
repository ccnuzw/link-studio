package dramaoutput

import "testing"

func TestVoicesPerStoryboardSegment(t *testing.T) {
	voiced := map[string]bool{"a": true, "b": true}
	segment := StoryboardSegment{Prompt: "@[少年](a) @[同一人物](a) @[场景](c)"}
	output := StoryboardOutput{Segments: []StoryboardSegment{segment, {Prompt: "@[老年](b)"}}}
	if err := output.ValidateVoices(1, voiced); err != nil {
		t.Fatal(err)
	}
	output.Segments[0].Prompt += " @[老年](b)"
	if output.ValidateVoices(1, voiced) == nil || output.ValidateVoices(0, voiced) != nil {
		t.Fatal("expected distinct voiced references to be limited only for a positive cap")
	}
}
