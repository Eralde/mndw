package events

import (
	contractEvents "mndw.local/contracts/events"
)

type InternalPublisher struct {
	bus        *Bus
	normalizer *Normalizer
}

func NewInternalPublisher(bus *Bus, normalizer *Normalizer) *InternalPublisher {
	return &InternalPublisher{bus: bus, normalizer: normalizer}
}

func (p *InternalPublisher) Publish(topic contractEvents.Topic, payload map[string]any) error {
	event, err := p.normalizer.NormalizeInternal(topic, payload)
	if err != nil {
		return err
	}

	p.bus.Publish(event)

	return nil
}

func (p *InternalPublisher) PublishNamed(topic string, payload map[string]any) error {
	return p.Publish(contractEvents.Topic(topic), payload)
}
