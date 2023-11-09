'use strict';

import _ from "lodash";
import {ECSClient} from "@aws-sdk/client-ecs";
import {EC2Client} from "@aws-sdk/client-ec2";
import {Route53Client} from "@aws-sdk/client-route-53";

const clientECS = new ECSClient();
const clientEC2 = new EC2Client();
const route53 = new Route53Client();

/**
 * Upsert a public ip DNS record for the incoming task.
 *
 * @param event contains the task in the 'detail' propery
 */
exports.handler = async (event) => {
    console.log('Received event: %j', event);

    const task = event.detail;
    const clusterArn = task.clusterArn;
    console.log(`clusterArn: ${clusterArn}`)

    const clusterName = clusterArn.split(':cluster/')[1];

    const tags = await fetchClusterTags(clusterArn)
    const domain = tags['domain']
    const services = tags['services'].replace(' ', '').split('/')
    const hostedZoneId = tags['hostedZoneId']

    /*        const domain = process.env.DOMAIN
            const services = process.env.SERVICES.replace(' ', '').split(",")
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
    console.log(`task:${serviceName} public-id: ${taskPublicIp}`)

    if (!services.includes(serviceName)) {
        console.log('This service is not in the trigger list.');
        return;
    }

    const containerDomain = `${serviceName}.${domain}`
    const recordSet = createRecordSet(containerDomain, taskPublicIp)

    await updateDnsRecord(clusterName, hostedZoneId, recordSet)
    console.log(`DNS record update finished for ${containerDomain} (${taskPublicIp})`)
};


async function fetchClusterTags(clusterArn) {
    const response = await clientECS.listTags({
        resourceArn: clusterArn
    }).promise();
    return _.reduce(response.tags, function (hash, tag) {
        var key = tag['key'];
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
    const data = await clientEC2.describeNetworkInterfaces({
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
