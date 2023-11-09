'use strict';

const AWS = require('aws-sdk');
const _ = require('lodash')
const ec2 = new AWS.EC2();
const ecs = new AWS.ECS();
const lambda = new AWS.Lambda();
const route53 = new AWS.Route53();

exports.handler = async (event, context, callback) => {
    console.log('Received event: %j', event);

    const task = event.detail;
    const clusterArn = task.clusterArn;
    console.log(`clusterArn: ${clusterArn}`)

    const clusterName = clusterArn.split(':cluster/')[1];


    //const tags = await fetchClusterTags(clusterArn)
    const tags = await fetchLambdaTags(context.functionName)
    const domain = tags['domain']
    const services = tags['services'].replace(' ','').split(",")
    const hostedZoneId = tags['hostedZoneId']

    /*    const domain = process.env.DOMAIN
        const services = process.env.SERVICES.replace(' ','').split(",")
        const hostedZoneId = process.env.HOSTED_ZONE_ID*/


    console.log(`cluster: ${clusterName}, domain: ${domain}, services: ${services}, hostedZone: ${hostedZoneId}`)


    if (!domain || !hostedZoneId) {
        console.log(`Skipping. Reason: no "domain" and/or "hostedZoneId" tags found for cluster ${clusterArn}`);
        return;
    }

    const eniId = getEniId(task);
    if (!eniId) {
        console.log('Network interface not found');
        return;
    }

    const taskPublicIp = await fetchEniPublicIp(eniId)
    const serviceName = task.group.split(":")[1]
    console.log(`task:${serviceName} public-id:${taskPublicIp}`)

    if (!services.includes(serviceName)) {
        console.log('This service is not in the trigger list.');
        return;
    }

    const containerDomain = `${serviceName}.${domain}`
    const recordSet = createRecordSet(containerDomain, taskPublicIp)

    await updateDnsRecord(clusterName, hostedZoneId, recordSet)
    console.log(`DNS record update finished for ${containerDomain} (${taskPublicIp})`)
};

async function fetchLambdaTags(arn) {
    console.log(`1`)
    const response = await lambda.listTags({
        resourceArn: arn
    }).promise()
    const response2 = lambda.getFunction().promise()
    console.log(`2`)
    return _.reduce(response.tags, function (hash, tag) {
        let key = tag['key'];
        hash[key] = tag['value'];
        return hash;
    }, {});
}

async function fetchClusterTags(clusterArn) {
    console.log(`1`)
    const response = await ecs.listTagsForResource({
        resourceArn: clusterArn
    }).promise().then(() => console.log(`2`))
    console.log(`3`)
    return _.reduce(response.tags, function (hash, tag) {
        let key = tag['key'];
        hash[key] = tag['value'];
        return hash;
    }, {});
}

function getEniId(task) {
    return _.chain(task.attachments)
        .filter(function (attachment) {
            return attachment.type === 'eni'
        })
        .map(function (eniAttachment) {
            return _.chain(eniAttachment.details)
                .filter(function (details) {
                    return details.name === 'networkInterfaceId'
                })
                .map(function (details) {
                    return details.value
                })
                .head()
                .value()
        })
        .head()
        .value()
}

async function fetchEniPublicIp(eniId) {
    const data = await ec2.describeNetworkInterfaces({
        NetworkInterfaceIds: [
            eniId
        ]
    }).promise();

    return data.NetworkInterfaces[0].PrivateIpAddresses[0].Association.PublicIp;
}

function createRecordSet(domain, publicIp) {
    return {
        "Action": "UPSERT",
        "ResourceRecordSet": {
            "Name": domain,
            "Type": "A",
            "TTL": 180,
            "ResourceRecords": [
                {
                    "Value": publicIp
                }
            ]
        }
    }
}

async function updateDnsRecord(clusterName, hostedZoneId, changeRecordSet) {
    let param = {
        ChangeBatch: {
            "Comment": `Auto generated Record for ECS Fargate cluster ${clusterName}`,
            "Changes": [changeRecordSet]
        },
        HostedZoneId: hostedZoneId
    };
    const updateResult = await route53.changeResourceRecordSets(param).promise();
    console.log('updateResult: %j', updateResult);
}