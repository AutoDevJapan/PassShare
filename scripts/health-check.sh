#!/bin/bash
# Fargate疎通確認スクリプト
# Usage: ./scripts/health-check.sh [dev|stg|prd]

set -e

ENVIRONMENT=${1:-dev}
AWS_REGION="ap-northeast-1"
PROJECT_NAME="rpa-ai"

echo "🔍 Checking Fargate health for environment: $ENVIRONMENT"
echo ""

# Get ALB DNS name from Terraform output
echo "📋 Getting ALB DNS name..."
ALB_DNS=$(cd ai-infra/environments/$ENVIRONMENT && \
  terraform output -raw alb_dns_name 2>/dev/null || \
  aws elbv2 describe-load-balancers \
    --region $AWS_REGION \
    --query "LoadBalancers[?contains(LoadBalancerName, '${PROJECT_NAME}-${ENVIRONMENT}')].DNSName" \
    --output text)

if [ -z "$ALB_DNS" ]; then
  echo "❌ Could not find ALB DNS name"
  exit 1
fi

echo "✅ ALB DNS: $ALB_DNS"
echo ""

# Get CloudFront domain name
echo "📋 Getting CloudFront domain name..."
CLOUDFRONT_DOMAIN=$(cd ai-infra/environments/$ENVIRONMENT && \
  terraform output -raw cloudfront_domain_name 2>/dev/null || \
  aws cloudfront list-distributions \
    --region $AWS_REGION \
    --query "DistributionList.Items[?contains(Comment, '${PROJECT_NAME}-${ENVIRONMENT}')].DomainName" \
    --output text)

if [ -z "$CLOUDFRONT_DOMAIN" ]; then
  echo "⚠️  Could not find CloudFront domain name"
else
  echo "✅ CloudFront Domain: $CLOUDFRONT_DOMAIN"
fi
echo ""

# Check ECS Service status
echo "📋 Checking ECS Service status..."
CLUSTER_NAME="${PROJECT_NAME}-${ENVIRONMENT}-cluster"
SERVICE_NAME="${PROJECT_NAME}-${ENVIRONMENT}-service"

SERVICE_STATUS=$(aws ecs describe-services \
  --cluster $CLUSTER_NAME \
  --services $SERVICE_NAME \
  --region $AWS_REGION \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount,Deployments:deployments[0].{Status:status,TaskDef:taskDefinition}}' \
  --output json)

echo "$SERVICE_STATUS" | jq '.'
echo ""

# Check Target Group health
echo "📋 Checking Target Group health..."
TARGET_GROUP_NAME="${PROJECT_NAME}-${ENVIRONMENT}-tg"
TARGET_GROUP_ARN=$(aws elbv2 describe-target-groups \
  --region $AWS_REGION \
  --query "TargetGroups[?TargetGroupName=='${TARGET_GROUP_NAME}'].TargetGroupArn" \
  --output text)

if [ -n "$TARGET_GROUP_ARN" ]; then
  TARGET_HEALTH=$(aws elbv2 describe-target-health \
    --target-group-arn $TARGET_GROUP_ARN \
    --region $AWS_REGION \
    --query 'TargetHealthDescriptions[*].{Target:Target.Id,Port:Target.Port,Health:TargetHealth.State,Reason:TargetHealth.Reason}' \
    --output json)

  echo "$TARGET_HEALTH" | jq '.'
else
  echo "⚠️  Could not find target group"
fi
echo ""

# Test ALB endpoint
echo "🌐 Testing ALB endpoint..."
echo "  URL: http://$ALB_DNS/health"
ALB_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}\nTIME:%{time_total}" \
  http://$ALB_DNS/health || echo "FAILED")

if echo "$ALB_RESPONSE" | grep -q "HTTP_CODE:200"; then
  echo "✅ ALB health check: PASSED"
  echo "$ALB_RESPONSE" | grep -v "HTTP_CODE\|TIME" | jq '.' 2>/dev/null || echo "$ALB_RESPONSE" | grep -v "HTTP_CODE\|TIME"
else
  echo "❌ ALB health check: FAILED"
  echo "$ALB_RESPONSE"
fi
echo ""

# Test CloudFront endpoint (if available)
if [ -n "$CLOUDFRONT_DOMAIN" ]; then
  echo "🌐 Testing CloudFront endpoint..."
  echo "  URL: https://$CLOUDFRONT_DOMAIN/health"
  CF_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}\nTIME:%{time_total}" \
    https://$CLOUDFRONT_DOMAIN/health || echo "FAILED")

  if echo "$CF_RESPONSE" | grep -q "HTTP_CODE:200"; then
    echo "✅ CloudFront health check: PASSED"
    echo "$CF_RESPONSE" | grep -v "HTTP_CODE\|TIME" | jq '.' 2>/dev/null || echo "$CF_RESPONSE" | grep -v "HTTP_CODE\|TIME"
  else
    echo "❌ CloudFront health check: FAILED"
    echo "$CF_RESPONSE"
  fi
  echo ""
fi

# Test root endpoint
echo "🌐 Testing root endpoint..."
echo "  URL: http://$ALB_DNS/"
ROOT_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}\nTIME:%{time_total}" \
  http://$ALB_DNS/ || echo "FAILED")

if echo "$ROOT_RESPONSE" | grep -q "HTTP_CODE:200"; then
  echo "✅ Root endpoint check: PASSED"
  echo "$ROOT_RESPONSE" | grep -v "HTTP_CODE\|TIME" | jq '.' 2>/dev/null || echo "$ROOT_RESPONSE" | grep -v "HTTP_CODE\|TIME"
else
  echo "❌ Root endpoint check: FAILED"
  echo "$ROOT_RESPONSE"
fi
echo ""

echo "✅ Health check completed!"
