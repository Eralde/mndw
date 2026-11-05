#!/bin/sh
# GET /hello exec endpoint for the hello-widget example.
printf 'Content-Type: application/json\r\n\r\n'
printf '{"message":"hello from hello-widget"}\n'
