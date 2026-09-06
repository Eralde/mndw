package events

import (
	"fmt"
	"strings"
)

type TopicFilter struct {
	all      bool
	prefixes []string
}

func ParseTopicFilter(topics []string) (TopicFilter, error) {
	filter := TopicFilter{}
	seen := make(map[string]struct{}, len(topics))

	for _, topic := range topics {
		if topic == "*" {
			filter.all = true

			continue
		}

		if topic == "" || strings.HasSuffix(topic, ".") || strings.HasPrefix(topic, ".") {
			return TopicFilter{}, fmt.Errorf("invalid topic filter %q", topic)
		}

		if _, ok := seen[topic]; ok {
			continue
		}

		seen[topic] = struct{}{}
		filter.prefixes = append(filter.prefixes, topic)
	}

	return filter, nil
}

func (f TopicFilter) Matches(topic string) bool {
	if f.all {
		return true
	}

	for _, prefix := range f.prefixes {
		if topic == prefix || strings.HasPrefix(topic, prefix+".") {
			return true
		}
	}

	return false
}

func (f TopicFilter) Empty() bool {
	return !f.all && len(f.prefixes) == 0
}
